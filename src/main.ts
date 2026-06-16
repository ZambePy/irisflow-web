import './style.css';
import { FilesetResolver, FaceLandmarker } from '@mediapipe/tasks-vision';

const video = document.getElementById('webcam') as HTMLVideoElement;
const canvas = document.getElementById('output_canvas') as HTMLCanvasElement;
const laser = document.getElementById('laser') as HTMLDivElement;
const loadingMsg = document.getElementById('loading') as HTMLDivElement;

let faceLandmarker: FaceLandmarker;
let lastVideoTime = -1;

// Coordenadas para interpolação (Lerp)
let targetX = window.innerWidth / 2;
let targetY = window.innerHeight / 2;
let currentX = window.innerWidth / 2;
let currentY = window.innerHeight / 2;

// Limites padrão para calibração auto-adaptativa
const DEFAULT_MIN_X = 0.35;
const DEFAULT_MAX_X = 0.65;
const DEFAULT_MIN_Y = -0.07;
const DEFAULT_MAX_Y = 0.07;

let minX = DEFAULT_MIN_X;
let maxX = DEFAULT_MAX_X;
let minY = DEFAULT_MIN_Y;
let maxY = DEFAULT_MAX_Y;

// Fator de decaimento para fazer os limites retornarem lentamente aos padrões
const CALIBRATION_DECAY = 0.0001; // Ajusta a velocidade de auto-recuperação

const lerp = (start: number, end: number, factor: number) => {
  return start + (end - start) * factor;
};

const clamp = (val: number, min: number, max: number) => Math.min(Math.max(val, min), max);

const mapRange = (val: number, inMin: number, inMax: number, outMin: number, outMax: number) => {
  return (val - inMin) * (outMax - outMin) / (inMax - inMin) + outMin;
};

async function initMediaPipe() {
  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
  );
  
  faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: `https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task`,
      delegate: "GPU"
    },
    outputFaceBlendshapes: false,
    runningMode: "VIDEO",
    numFaces: 1
  });
  
  loadingMsg.style.display = 'none';
  startCamera();
}

async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 1280, height: 720, facingMode: "user" }
    });
    video.srcObject = stream;
    video.addEventListener("loadeddata", predictWebcam);
  } catch (err) {
    console.error("Erro ao acessar a câmera:", err);
    loadingMsg.innerText = "Erro ao acessar a câmera.";
  }
}

async function predictWebcam() {
  if (canvas.width !== video.videoWidth) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  }

  let startTimeMs = performance.now();
  if (lastVideoTime !== video.currentTime) {
    lastVideoTime = video.currentTime;
    
    // Detectar rostos
    const results = faceLandmarker.detectForVideo(video, startTimeMs);
    
    if (results.faceLandmarks && results.faceLandmarks.length > 0) {
      const landmarks = results.faceLandmarks[0];
      
      // Olho Direito do Usuário (Lado esquerdo da imagem)
      const irisL = landmarks[468];
      const eyeOuterL = landmarks[33];
      const eyeInnerL = landmarks[133];
      
      const eyeWidthL = Math.abs(eyeOuterL.x - eyeInnerL.x);
      const minEyeXL = Math.min(eyeOuterL.x, eyeInnerL.x);
      let ratioXL = (irisL.x - minEyeXL) / eyeWidthL;
      ratioXL = 1.0 - ratioXL;
      
      const stableCenterYL = (eyeOuterL.y + eyeInnerL.y) / 2;
      const dyL = (irisL.y - stableCenterYL) / eyeWidthL;

      // Olho Esquerdo do Usuário (Lado direito da imagem)
      const irisR = landmarks[473];
      const eyeOuterR = landmarks[263];
      const eyeInnerR = landmarks[362];
      
      const eyeWidthR = Math.abs(eyeOuterR.x - eyeInnerR.x);
      const minEyeXR = Math.min(eyeOuterR.x, eyeInnerR.x);
      let ratioXR = (irisR.x - minEyeXR) / eyeWidthR;
      ratioXR = 1.0 - ratioXR;
      
      const stableCenterYR = (eyeOuterR.y + eyeInnerR.y) / 2;
      const dyR = (irisR.y - stableCenterYR) / eyeWidthR;

      // Média dos dois olhos para maior estabilidade
      const ratioX = (ratioXL + ratioXR) / 2;
      const dy = (dyL + dyR) / 2;

      // Calibração auto-adaptativa: expande os limites dinamicamente se o usuário olhar além
      if (ratioX < minX) minX = ratioX;
      if (ratioX > maxX) maxX = ratioX;
      if (dy < minY) minY = dy;
      if (dy > maxY) maxY = dy;

      // Decaimento suave dos limites de calibração em direção aos valores padrão
      // Isso evita que ruídos persistam por muito tempo nas margens extremas
      minX = lerp(minX, DEFAULT_MIN_X, CALIBRATION_DECAY);
      maxX = lerp(maxX, DEFAULT_MAX_X, CALIBRATION_DECAY);
      minY = lerp(minY, DEFAULT_MIN_Y, CALIBRATION_DECAY);
      maxY = lerp(maxY, DEFAULT_MAX_Y, CALIBRATION_DECAY);

      // Mapeamento dos limites dinâmicos para a resolução da tela
      const mappedX = mapRange(ratioX, minX, maxX, 0, window.innerWidth);
      const mappedY = mapRange(dy, minY, maxY, 0, window.innerHeight);

      // Limitar aos limites da tela
      targetX = clamp(mappedX, 0, window.innerWidth);
      targetY = clamp(mappedY, 0, window.innerHeight);
    }
  }

  // Suavizar o movimento (Lerp) para dar o efeito "tecnológico"
  // Fator de suavização de 0.05 para aumentar a responsividade em relação ao antigo 0.03
  currentX = lerp(currentX, targetX, 0.05);
  currentY = lerp(currentY, targetY, 0.05);
  
  laser.style.left = `${currentX}px`;
  laser.style.top = `${currentY}px`;

  window.requestAnimationFrame(predictWebcam);
}

initMediaPipe();
