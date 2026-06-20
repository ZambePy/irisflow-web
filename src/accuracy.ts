import { mapGazeDiag, getTrainBounds, type GazeDiag } from './calibration';

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

  // Loga o envelope de treino uma vez no início do teste
  const bounds = getTrainBounds();
  console.group('[IrisFlow] Teste de acurácia — diagnóstico de entrada');
  console.log(
    `Envelope de treino: rawX=[${bounds.minRX.toFixed(4)}, ${bounds.maxRX.toFixed(4)}]  ` +
    `dy=[${bounds.minDY.toFixed(4)}, ${bounds.maxDY.toFixed(4)}]`
  );
  console.log(
    'Durante cada ponto, serão logados: ponto | rawX | dy | rawNX(pré-clamp) | rawNY(pré-clamp) | ' +
    'clamped? | outOfBounds? | → predição (px)'
  );
  console.groupEnd();

  function runNextPoint() {
    if (pointIndex >= VALIDATION_POINTS.length) {
      finishTest(overlay, pointErrors, onComplete);
      return;
    }

    const vp = VALIDATION_POINTS[pointIndex];
    showValidationDot(overlay, vp, pointIndex);

    const startTime   = performance.now();
    const predictedX: number[] = [];
    const predictedY: number[] = [];

    // Acumula raws para resumo por ponto
    const rawsRX: number[] = [];
    const rawsDY: number[] = [];
    const diagFrames: GazeDiag[] = [];

    const targetScreenX = vp.screenX * window.innerWidth;
    const targetScreenY = vp.screenY * window.innerHeight;

    function collect() {
      const elapsed = performance.now() - startTime;

      const diag = mapGazeDiag(rawFeedX, rawFeedY);
      if (diag) {
        predictedX.push(diag.x);
        predictedY.push(diag.y);
        rawsRX.push(rawFeedX);
        rawsDY.push(rawFeedY);
        diagFrames.push(diag);

        // Log frame-a-frame: rawX/dy brutos + saída do modelo + flags de extrapolação
        const clampStr  = (diag.clampedX || diag.clampedY)
          ? ` ⚠CLAMP(${diag.clampedX ? 'X' : ''}${diag.clampedY ? 'Y' : ''})`
          : '';
        const boundsStr = diag.outOfBounds ? ' ⚠FORA-TREINO' : '';
        console.log(
          `[val pt${pointIndex + 1}/${VALIDATION_POINTS.length} ${vp.name}] ` +
          `rawX=${rawFeedX.toFixed(4)} dy=${rawFeedY.toFixed(4)} | ` +
          `rawNorm=(${diag.rawNX.toFixed(4)},${diag.rawNY.toFixed(4)})` +
          `${clampStr}${boundsStr} ` +
          `→ (${Math.round(diag.x)}px, ${Math.round(diag.y)}px)`
        );
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
        const dx  = meanPX - targetScreenX;
        const dy2 = meanPY - targetScreenY;
        error = Math.sqrt(dx * dx + dy2 * dy2);
      }

      // Resumo por ponto de validação
      const meanRX   = rawsRX.reduce((s, v) => s + v, 0) / (rawsRX.length || 1);
      const meanDY   = rawsDY.reduce((s, v) => s + v, 0) / (rawsDY.length || 1);
      const nClamp   = diagFrames.filter(d => d.clampedX || d.clampedY).length;
      const nOOB     = diagFrames.filter(d => d.outOfBounds).length;
      const bounds2  = getTrainBounds();

      console.group(
        `[val resumo pt${pointIndex + 1}] ${vp.name} → erro=${Math.round(error)}px`
      );
      console.log(
        `  rawX médio=${meanRX.toFixed(4)} (treino: [${bounds2.minRX.toFixed(4)}, ${bounds2.maxRX.toFixed(4)}]) ` +
        `${meanRX < bounds2.minRX - 0.05 || meanRX > bounds2.maxRX + 0.05 ? '⚠ FORA' : '✓ dentro'}`
      );
      console.log(
        `  dy   médio=${meanDY.toFixed(4)} (treino: [${bounds2.minDY.toFixed(4)}, ${bounds2.maxDY.toFixed(4)}]) ` +
        `${meanDY < bounds2.minDY - 0.05 || meanDY > bounds2.maxDY + 0.05 ? '⚠ FORA' : '✓ dentro'}`
      );
      console.log(
        `  Frames com clamp de saída: ${nClamp}/${diagFrames.length} | ` +
        `Frames fora do envelope de treino: ${nOOB}/${diagFrames.length}`
      );
      console.log(`  Alvo: (${targetScreenX.toFixed(0)}px, ${targetScreenY.toFixed(0)}px)`);
      console.groupEnd();

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
