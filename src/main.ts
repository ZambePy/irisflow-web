import './style.css';
import { FilesetResolver, FaceLandmarker } from '@mediapipe/tasks-vision';
import * as calibration from './calibration';
import { feedAccuracyRaw } from './accuracy';

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

// Rolling buffer de 6 frames para suavização ponderada (inspirado no EyeGestures engine)
// Reduz jitter especialmente nas bordas da tela onde o sinal é mais ruidoso
const BUFFER_SIZE = 6;
const bufferX: number[] = [];
const bufferY: number[] = [];
// Pesos crescentes: frames mais recentes têm maior influência
const BUFFER_WEIGHTS = [1, 2, 3, 4, 5, 6];

function weightedBufferAvg(buf: number[]): number {
  const len = buf.length;
  if (len === 0) return 0;
  let weightSum = 0;
  let valueSum = 0;
  for (let i = 0; i < len; i++) {
    const w = BUFFER_WEIGHTS[BUFFER_SIZE - len + i];
    valueSum += buf[i] * w;
    weightSum += w;
  }
  return valueSum / weightSum;
}

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
const CALIBRATION_DECAY = 0.0001;

const lerp = (start: number, end: number, factor: number) => {
  return start + (end - start) * factor;
};

const clamp = (val: number, min: number, max: number) => Math.min(Math.max(val, min), max);

const mapRange = (val: number, inMin: number, inMax: number, outMin: number, outMax: number) => {
  return (val - inMin) * (outMax - outMin) / (inMax - inMin) + outMin;
};

// Extrai a submatriz 3x3 de rotação de uma matriz 4x4 column-major
function extractRotationMatrix(m: number[]): number[][] {
  return [
    [m[0], m[4], m[8]],
    [m[1], m[5], m[9]],
    [m[2], m[6], m[10]]
  ];
}

// Aplica uma matriz 3x3 a um ponto 3D
function applyMatrix3(R: number[][], p: { x: number; y: number; z: number }) {
  return {
    x: R[0][0] * p.x + R[0][1] * p.y + R[0][2] * p.z,
    y: R[1][0] * p.x + R[1][1] * p.y + R[1][2] * p.z,
    z: R[2][0] * p.x + R[2][1] * p.y + R[2][2] * p.z
  };
}

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
    outputFacialTransformationMatrixes: true,
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

    const results = faceLandmarker.detectForVideo(video, startTimeMs);

    if (results.faceLandmarks && results.faceLandmarks.length > 0) {
      const landmarks = results.faceLandmarks[0];

      // Compensa a pose da cabeça: M transforma do espaço canônico da cabeça para o espaço
      // da câmera (P_camera = M * P_head). A transposta R^T é a inversa para matrizes
      // de rotação, mapeando de volta para o espaço local da cabeça (P_head = R^T * P_camera).
      // Isso remove o efeito da rotação da cabeça dos landmarks antes de calcular os ratios.
      let Rinv: number[][] | null = null;
      if (results.facialTransformationMatrixes && results.facialTransformationMatrixes.length > 0) {
        const R = extractRotationMatrix(Array.from(results.facialTransformationMatrixes[0].data));
        Rinv = [
          [R[0][0], R[1][0], R[2][0]],
          [R[0][1], R[1][1], R[2][1]],
          [R[0][2], R[1][2], R[2][2]]
        ];
      }

      const toHead = (p: { x: number; y: number; z: number }) =>
        Rinv ? applyMatrix3(Rinv, p) : p;

      // Olho Direito do Usuário (Lado esquerdo da imagem)
      // Centro da íris calculado pela média do ponto central (468) e de contorno (469 a 472)
      const irisL_cam = {
        x: (landmarks[468].x + landmarks[469].x + landmarks[470].x + landmarks[471].x + landmarks[472].x) / 5,
        y: (landmarks[468].y + landmarks[469].y + landmarks[470].y + landmarks[471].y + landmarks[472].y) / 5,
        z: (landmarks[468].z + landmarks[469].z + landmarks[470].z + landmarks[471].z + landmarks[472].z) / 5
      };
      const irisL = toHead(irisL_cam);
      const eyeOuterL = toHead(landmarks[33]);
      const eyeInnerL = toHead(landmarks[133]);

      const eyeWidthL = Math.abs(eyeOuterL.x - eyeInnerL.x);
      const minEyeXL = Math.min(eyeOuterL.x, eyeInnerL.x);
      let ratioXL = (irisL.x - minEyeXL) / eyeWidthL;
      ratioXL = 1.0 - ratioXL;

      const stableCenterYL = (eyeOuterL.y + eyeInnerL.y) / 2;
      const dyL = (irisL.y - stableCenterYL) / eyeWidthL;

      // Olho Esquerdo do Usuário (Lado direito da imagem)
      // Centro da íris calculado pela média do ponto central (473) e de contorno (474 a 477)
      const irisR_cam = {
        x: (landmarks[473].x + landmarks[474].x + landmarks[475].x + landmarks[476].x + landmarks[477].x) / 5,
        y: (landmarks[473].y + landmarks[474].y + landmarks[475].y + landmarks[476].y + landmarks[477].y) / 5,
        z: (landmarks[473].z + landmarks[474].z + landmarks[475].z + landmarks[476].z + landmarks[477].z) / 5
      };
      const irisR = toHead(irisR_cam);
      const eyeOuterR = toHead(landmarks[263]);
      const eyeInnerR = toHead(landmarks[362]);

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
      minX = lerp(minX, DEFAULT_MIN_X, CALIBRATION_DECAY);
      maxX = lerp(maxX, DEFAULT_MAX_X, CALIBRATION_DECAY);
      minY = lerp(minY, DEFAULT_MIN_Y, CALIBRATION_DECAY);
      maxY = lerp(maxY, DEFAULT_MAX_Y, CALIBRATION_DECAY);

      // Envia coordenadas cruas para o sistema de calibração (registra se estiver capturando)
      calibration.feedRawData(ratioX, dy);

      // Alimenta o módulo de precisão com as coordenadas cruas
      feedAccuracyRaw(ratioX, dy);

      // Tenta mapear o olhar usando o perfil calibrado
      const calibratedGaze = calibration.mapGaze(ratioX, dy);

      if (calibratedGaze) {
        targetX = calibratedGaze.x;
        targetY = calibratedGaze.y;
      } else {
        // Mapeamento dos limites dinâmicos (fallback) para a resolução da tela
        const mappedX = mapRange(ratioX, minX, maxX, 0, window.innerWidth);
        const mappedY = mapRange(dy, minY, maxY, 0, window.innerHeight);

        targetX = clamp(mappedX, 0, window.innerWidth);
        targetY = clamp(mappedY, 0, window.innerHeight);
      }

      // Atualiza o rolling buffer com o target calculado
      bufferX.push(targetX);
      bufferY.push(targetY);
      if (bufferX.length > BUFFER_SIZE) bufferX.shift();
      if (bufferY.length > BUFFER_SIZE) bufferY.shift();

      // Substitui targetX/Y pela média ponderada do buffer antes do LERP
      targetX = weightedBufferAvg(bufferX);
      targetY = weightedBufferAvg(bufferY);
    }
  }

  // Suavizar o movimento (Lerp)
  currentX = lerp(currentX, targetX, 0.05);
  currentY = lerp(currentY, targetY, 0.05);

  // Ocultar laser durante calibração para evitar distração ocular do usuário
  if (calibration.isCalibrating) {
    laser.style.display = 'none';
  } else {
    laser.style.display = 'block';
    laser.style.left = `${currentX}px`;
    laser.style.top = `${currentY}px`;
  }

  window.requestAnimationFrame(predictWebcam);
}

// Inicializa o painel de calibração e carrega perfis salvos
calibration.init();

initMediaPipe();
