import { mapGaze } from './calibration';

export interface AccuracyResult {
  meanError: number;   // Erro médio em pixels
  maxError: number;    // Pior erro em pixels
  errorPct: number;    // Erro médio como % da diagonal da tela
  score: string;       // Rótulo qualitativo
  colorClass: string;  // Classe CSS para colorir o painel
  pointErrors: number[]; // Erro por ponto de validação
}

// 5 pontos de validação: 4 cantos + centro
const VALIDATION_POINTS = [
  { name: "Centro",               screenX: 0.5,  screenY: 0.5  },
  { name: "Canto Superior Esq",   screenX: 0.03, screenY: 0.03 },
  { name: "Canto Superior Dir",   screenX: 0.97, screenY: 0.03 },
  { name: "Canto Inferior Esq",   screenX: 0.03, screenY: 0.97 },
  { name: "Canto Inferior Dir",   screenX: 0.97, screenY: 0.97 },
];

const COLLECTION_MS = 600;

let rawFeedX = 0;
let rawFeedY = 0;

// Recebe a posição crua do olhar a cada frame — chamado por main.ts
export function feedAccuracyRaw(ratioX: number, dy: number) {
  rawFeedX = ratioX;
  rawFeedY = dy;
}

// Inicia o teste de validação de precisão pós-calibração
export function startAccuracyTest(onComplete: (result: AccuracyResult) => void) {
  const overlay = createAccuracyOverlay();
  let pointIndex = 0;
  const pointErrors: number[] = [];

  function runNextPoint() {
    if (pointIndex >= VALIDATION_POINTS.length) {
      finishTest(overlay, pointErrors, onComplete);
      return;
    }

    const vp = VALIDATION_POINTS[pointIndex];
    showValidationDot(overlay, vp, pointIndex);

    const startTime = performance.now();
    const predictedX: number[] = [];
    const predictedY: number[] = [];

    const targetScreenX = vp.screenX * window.innerWidth;
    const targetScreenY = vp.screenY * window.innerHeight;

    function collect() {
      const elapsed = performance.now() - startTime;

      const gaze = mapGaze(rawFeedX, rawFeedY);
      if (gaze) {
        predictedX.push(gaze.x);
        predictedY.push(gaze.y);
      }

      if (elapsed < COLLECTION_MS) {
        requestAnimationFrame(collect);
        return;
      }

      // Calcula erro Euclidiano médio para este ponto
      let error = 0;
      if (predictedX.length > 0) {
        const meanPX = predictedX.reduce((s, v) => s + v, 0) / predictedX.length;
        const meanPY = predictedY.reduce((s, v) => s + v, 0) / predictedY.length;
        const dx = meanPX - targetScreenX;
        const dy2 = meanPY - targetScreenY;
        error = Math.sqrt(dx * dx + dy2 * dy2);
      }

      pointErrors.push(error);
      pointIndex++;
      setTimeout(runNextPoint, 300);
    }

    requestAnimationFrame(collect);
  }

  // Pequena pausa inicial para o usuário se preparar
  setTimeout(runNextPoint, 500);
}

function createAccuracyOverlay(): HTMLDivElement {
  const overlay = document.createElement("div");
  overlay.id = "accuracy-overlay";
  overlay.className = "accuracy-overlay";
  overlay.innerHTML = `
    <div class="accuracy-instruction">
      Teste de Precisão — olhe para cada ponto
    </div>
  `;
  document.body.appendChild(overlay);
  return overlay;
}

function showValidationDot(
  overlay: HTMLDivElement,
  vp: { name: string; screenX: number; screenY: number },
  index: number
) {
  const old = document.getElementById("accuracy-dot");
  if (old) old.remove();

  const dot = document.createElement("div");
  dot.id = "accuracy-dot";
  dot.className = "accuracy-dot";
  dot.style.left = `${vp.screenX * 100}vw`;
  dot.style.top  = `${vp.screenY * 100}vh`;
  dot.innerHTML  = `<div class="dot-inner"></div>`;

  const instr = overlay.querySelector(".accuracy-instruction") as HTMLElement;
  if (instr) {
    instr.innerHTML = `Teste de Precisão &nbsp;<span class="highlight">${index + 1}/${VALIDATION_POINTS.length}</span> — olhe para o ponto`;
  }

  overlay.appendChild(dot);
}

function finishTest(
  overlay: HTMLDivElement,
  pointErrors: number[],
  onComplete: (result: AccuracyResult) => void
) {
  overlay.remove();

  const meanError = pointErrors.reduce((s, v) => s + v, 0) / pointErrors.length;
  const maxError  = Math.max(...pointErrors);
  const diagonal  = Math.sqrt(window.innerWidth ** 2 + window.innerHeight ** 2);
  const errorPct  = (meanError / diagonal) * 100;

  let score: string;
  let colorClass: string;
  if (meanError < 30) {
    score = "Excelente";
    colorClass = "accuracy-excellent";
  } else if (meanError < 60) {
    score = "Bom";
    colorClass = "accuracy-good";
  } else if (meanError < 100) {
    score = "Regular";
    colorClass = "accuracy-regular";
  } else {
    score = "Ruim";
    colorClass = "accuracy-poor";
  }

  const result: AccuracyResult = { meanError, maxError, errorPct, score, colorClass, pointErrors };

  // Persiste resultado para exibir após reload
  try {
    localStorage.setItem("accuracyResult", JSON.stringify({
      meanError, maxError, errorPct, score, colorClass
    }));
  } catch (_) {}

  onComplete(result);
}
