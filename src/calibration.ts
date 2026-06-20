interface CalibrationPoint {
  screenX: number;
  screenY: number;
  rawX: number;
  rawY: number;
}

interface DynamicSample {
  screenX: number;
  screenY: number;
  rawX: number;
  rawY: number;
  weight: number;
}

const TARGET_POINTS = [
  { name: "Canto Superior Esquerdo",  screenX: 0.03, screenY: 0.03 },
  { name: "Superior Centro-Esquerdo", screenX: 0.35, screenY: 0.03 },
  { name: "Superior Centro-Direito",  screenX: 0.65, screenY: 0.03 },
  { name: "Canto Superior Direito",   screenX: 0.97, screenY: 0.03 },
  { name: "Médio-Alto Esquerdo",      screenX: 0.03, screenY: 0.35 },
  { name: "Médio-Alto Centro-Esq",    screenX: 0.35, screenY: 0.35 },
  { name: "Médio-Alto Centro-Dir",    screenX: 0.65, screenY: 0.35 },
  { name: "Médio-Alto Direito",       screenX: 0.97, screenY: 0.35 },
  { name: "Médio-Baixo Esquerdo",     screenX: 0.03, screenY: 0.65 },
  { name: "Médio-Baixo Centro-Esq",   screenX: 0.35, screenY: 0.65 },
  { name: "Médio-Baixo Centro-Dir",   screenX: 0.65, screenY: 0.65 },
  { name: "Médio-Baixo Direito",      screenX: 0.97, screenY: 0.65 },
  { name: "Canto Inferior Esquerdo",  screenX: 0.03, screenY: 0.97 },
  { name: "Inferior Centro-Esquerdo", screenX: 0.35, screenY: 0.97 },
  { name: "Inferior Centro-Direito",  screenX: 0.65, screenY: 0.97 },
  { name: "Canto Inferior Direito",   screenX: 0.97, screenY: 0.97 },
];

const COLLECTION_MS        = 1000;
const TRANSITION_MS        = 1000;
const DYN_MOVE_MS          = 1200;
const DYN_PULSE_MS         = 1500;
const STD_THRESHOLD_X      = 0.015;
const STD_THRESHOLD_Y      = 0.010;
const MAX_UNSTABLE_RETRIES = 2;

// Snake path 3×3 cobrindo toda a tela
const DYNAMIC_WAYPOINTS = [
  { x: 0.05, y: 0.05 },
  { x: 0.50, y: 0.05 },
  { x: 0.95, y: 0.05 },
  { x: 0.95, y: 0.50 },
  { x: 0.50, y: 0.50 },
  { x: 0.05, y: 0.50 },
  { x: 0.05, y: 0.95 },
  { x: 0.50, y: 0.95 },
  { x: 0.95, y: 0.95 },
];

// Peso relativo de cada ponto estático vs. uma amostra dinâmica individual.
// Cada ponto estático representa ~30 frames de fixação cuidadosa — vale muito mais.
const W_STATIC = 30;

let profile: CalibrationPoint[] = [];
export let isCalibrating = false;
let isDynamicCalibrating = false;
let currentPointIndex = 0;
let isCollecting = false;
let collectionStartTime = 0;
let collectedRawX: number[] = [];
let collectedRawY: number[] = [];
let unstableRetries = 0;

let dynamicSamples: DynamicSample[] = [];
let dynamicBallX = 0.5;
let dynamicBallY = 0.5;
let dynamicIsFixation = false;

// Coeficientes do modelo ridge pré-computados (recalculados após calibrar/carregar)
let ridgeCoefX: number[] | null = null;
let ridgeCoefY: number[] | null = null;

// ── Ridge Regression ─────────────────────────────────────────────────────────

// Base polinomial grau 2 em 2D: [1, r, d, r², r·d, d²]
// Captura distorção linear, curvatura e interação entre eixos — tudo relevante
// em eye tracking via webcam onde a relação iris→tela não é linear.
function buildFeatures(r: number, d: number): number[] {
  return [1, r, d, r * r, r * d, d * d];
}

// Eliminação gaussiana com pivotamento parcial — resolve Ax = b.
// 6×6 é trivial; cópias internas evitam mutar os argumentos.
function solveLinear(A_in: number[][], b_in: number[]): number[] {
  const n = A_in.length;
  const A = A_in.map(row => [...row]);
  const b = [...b_in];

  for (let col = 0; col < n; col++) {
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(A[row][col]) > Math.abs(A[maxRow][col])) maxRow = row;
    }
    [A[col], A[maxRow]] = [A[maxRow], A[col]];
    [b[col], b[maxRow]] = [b[maxRow], b[col]];

    const pivot = A[col][col];
    if (Math.abs(pivot) < 1e-14) continue;

    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const f = A[row][col] / pivot;
      for (let j = col; j < n; j++) A[row][j] -= f * A[col][j];
      b[row] -= f * b[col];
    }
  }
  return b.map((v, i) => (Math.abs(A[i][i]) < 1e-14 ? 0 : v / A[i][i]));
}

// Ridge regression ponderada: w = (XᵀWX + λI)⁻¹ XᵀW y
// Não regulariza o intercepto (índice 0) para preservar a escala global.
function fitRidgeWeighted(
  rs: number[], ds: number[],
  tgX: number[], tgY: number[],
  ws: number[],
  lambda: number
): { coefX: number[]; coefY: number[] } {
  const n  = rs.length;
  const nf = 6;
  const X  = rs.map((r, i) => buildFeatures(r, ds[i]));

  const XtWX  = Array.from({ length: nf }, () => new Array(nf).fill(0));
  const XtWYx = new Array(nf).fill(0);
  const XtWYy = new Array(nf).fill(0);

  for (let i = 0; i < n; i++) {
    const w = ws[i];
    for (let j = 0; j < nf; j++) {
      XtWYx[j] += w * X[i][j] * tgX[i];
      XtWYy[j] += w * X[i][j] * tgY[i];
      for (let k = 0; k < nf; k++) XtWX[j][k] += w * X[i][j] * X[i][k];
    }
  }
  for (let j = 1; j < nf; j++) XtWX[j][j] += lambda;

  return {
    coefX: solveLinear(XtWX, XtWYx),
    coefY: solveLinear(XtWX.map(r => [...r]), XtWYy),
  };
}

// LOOCV shortcut para ridge ponderada.
// Fórmula: e_LOO_i = (yᵢ − ŷᵢ) / (1 − Hᵢᵢ)
// onde Hᵢᵢ = wᵢ · xᵢᵀ (XᵀWX + λI)⁻¹ xᵢ
// Evita re-treinar o modelo N vezes — O(nf³) por lambda candidato.
function loocvPixelError(
  rs: number[], ds: number[],
  tgX: number[], tgY: number[],
  ws: number[],
  lambda: number
): number {
  const n  = rs.length;
  const nf = 6;
  const X  = rs.map((r, i) => buildFeatures(r, ds[i]));

  // Monta XᵀWX + λI
  const XtWX = Array.from({ length: nf }, () => new Array(nf).fill(0));
  for (let i = 0; i < n; i++) {
    const w = ws[i];
    for (let j = 0; j < nf; j++)
      for (let k = 0; k < nf; k++) XtWX[j][k] += w * X[i][j] * X[i][k];
  }
  for (let j = 1; j < nf; j++) XtWX[j][j] += lambda;

  // Inverte (XᵀWX + λI) coluna por coluna: inv[c][r] = A⁻¹[r][c]
  const inv = Array.from({ length: nf }, (_, c) => {
    const e = new Array(nf).fill(0); e[c] = 1;
    return solveLinear(XtWX.map(row => [...row]), e);
  });

  const { coefX, coefY } = fitRidgeWeighted(rs, ds, tgX, tgY, ws, lambda);

  const W = window?.innerWidth  ?? 1920;
  const H = window?.innerHeight ?? 1080;

  let totalErr = 0;
  for (let i = 0; i < n; i++) {
    const xi = X[i];

    // Hᵢᵢ = wᵢ · xᵢᵀ A⁻¹ xᵢ
    let hii = 0;
    for (let j = 0; j < nf; j++) {
      let axj = 0;
      for (let k = 0; k < nf; k++) axj += inv[k][j] * xi[k]; // (A⁻¹ xᵢ)[j]
      hii += xi[j] * axj;
    }
    hii = Math.min(ws[i] * hii, 0.9999);

    const predX = coefX.reduce((s, c, j) => s + c * xi[j], 0);
    const predY = coefY.reduce((s, c, j) => s + c * xi[j], 0);
    const cvX   = (tgX[i] - predX) / (1 - hii);
    const cvY   = (tgY[i] - predY) / (1 - hii);

    // Converte para pixels antes de acumular — métrica interpretável
    totalErr += Math.sqrt((cvX * W) ** 2 + (cvY * H) ** 2);
  }
  return totalErr / n; // erro médio euclidiano LOOCV em pixels
}

// Grid search sobre candidatos de lambda; usa apenas os 16 pontos estáticos
// com pesos iguais para isolar a capacidade de generalização do modelo.
function selectLambda(
  rs: number[], ds: number[],
  tgX: number[], tgY: number[]
): { lambda: number; report: [number, number][] } {
  const candidates = [0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1.0, 2.0];
  const ws = rs.map(() => 1); // pesos iguais para LOOCV — avalia só generalização

  let bestLambda = candidates[0];
  let bestErr    = Infinity;
  const report: [number, number][] = [];

  for (const lambda of candidates) {
    const err = loocvPixelError(rs, ds, tgX, tgY, ws, lambda);
    report.push([lambda, err]);
    if (err < bestErr) { bestErr = err; bestLambda = lambda; }
  }
  return { lambda: bestLambda, report };
}

// Treina (ou re-treina) o modelo ridge com os pontos estáticos do profile
// e, opcionalmente, as amostras dinâmicas coletadas na Fase 2.
// Chamada automaticamente ao carregar/salvar o perfil.
export function retrainRidgeModel(extSamples: DynamicSample[] = []) {
  if (profile.length !== 16) { ridgeCoefX = null; ridgeCoefY = null; return; }

  // Arrays de treino: estáticos primeiro, dinâmicos depois
  const rs:  number[] = [];
  const ds:  number[] = [];
  const tgX: number[] = [];
  const tgY: number[] = [];
  const ws:  number[] = [];

  for (const pt of profile) {
    rs.push(pt.rawX); ds.push(pt.rawY);
    tgX.push(pt.screenX); tgY.push(pt.screenY);
    ws.push(W_STATIC);
  }
  for (const s of extSamples) {
    rs.push(s.rawX); ds.push(s.rawY);
    tgX.push(s.screenX); tgY.push(s.screenY);
    ws.push(s.weight);
  }

  // Seleciona lambda via LOOCV nos 16 pontos estáticos (proxy de generalização)
  const staticRs  = profile.map(p => p.rawX);
  const staticDs  = profile.map(p => p.rawY);
  const staticTgX = profile.map(p => p.screenX);
  const staticTgY = profile.map(p => p.screenY);
  const { lambda, report } = selectLambda(staticRs, staticDs, staticTgX, staticTgY);

  // Fit final com todos os dados disponíveis (estáticos + dinâmicos)
  const { coefX, coefY } = fitRidgeWeighted(rs, ds, tgX, tgY, ws, lambda);
  ridgeCoefX = coefX;
  ridgeCoefY = coefY;

  logRidgeReport(lambda, report, extSamples.length);
}

function logRidgeReport(
  lambda: number,
  report: [number, number][],
  nDynamic: number
) {
  const selected = report.find(([l]) => l === lambda);
  const olsEntry = report.find(([l]) => l === 0.0001); // proxy para OLS (sem reg.)

  console.group('[IrisFlow] Ridge Regression — Relatório de Calibração');
  console.log(`Pontos estáticos: 16 | Amostras dinâmicas: ${nDynamic} | λ selecionado: ${lambda}`);
  console.log(`LOOCV médio (px) — ridge (λ=${lambda}): ${selected?.[1].toFixed(1)}px`);
  if (olsEntry) {
    console.log(`LOOCV médio (px) — OLS referência (λ→0): ${olsEntry[1].toFixed(1)}px`);
    const gain = olsEntry[1] - (selected?.[1] ?? 0);
    console.log(`Ganho da regularização: ${gain.toFixed(1)}px de redução no LOOCV`);
  }
  console.log('Curva LOOCV por λ:');
  for (const [l, e] of report) {
    const marker = l === lambda ? ' ← selecionado' : '';
    console.log(`  λ=${l}: ${e.toFixed(1)}px${marker}`);
  }
  console.log('Bilinear: resíduo 0 no treino por construção — LOOCV real indisponível');
  console.log('Referência: o teste de precisão pós-calibração mede o erro nos 5 pontos de validação.');
  console.groupEnd();
}

// ── Perfil e Estado ───────────────────────────────────────────────────────────

export function loadProfile(): boolean {
  try {
    const saved = localStorage.getItem("calibrationProfile");
    if (saved) {
      profile = JSON.parse(saved);
      if (profile.length === 16) {
        retrainRidgeModel([]); // re-constrói coeficientes a partir do perfil salvo
        return true;
      }
    }
  } catch (e) {
    console.error("Erro ao carregar calibrationProfile:", e);
  }
  profile = [];
  return false;
}

function saveProfile() {
  // Salva apenas os 16 pontos estáticos brutos — os coeficientes ridge são
  // recalculados em tempo de execução, então não precisam ser persistidos.
  localStorage.setItem("calibrationProfile", JSON.stringify(profile));
}

export function clearCalibration() {
  profile = [];
  ridgeCoefX = null;
  ridgeCoefY = null;
  localStorage.removeItem("calibrationProfile");
  localStorage.removeItem("accuracyResult");
  updateStatusUI();
}

export function isCalibrated(): boolean {
  return profile.length === 16 && ridgeCoefX !== null;
}

// ── Fluxo de Calibração ───────────────────────────────────────────────────────

export function startCalibrationMode() {
  if (isCalibrating) return;
  isCalibrating = true;
  currentPointIndex = 0;
  isCollecting = false;
  unstableRetries = 0;
  profile = [];
  ridgeCoefX = null;
  ridgeCoefY = null;

  createCalibrationOverlay();
  showNextPoint();
  window.addEventListener("keydown", handleGlobalKeyDown);
}

function runAccuracyTest() {
  setTimeout(() => {
    import('./accuracy').then(({ startAccuracyTest }) => {
      startAccuracyTest((result) => updateStatusUI(result));
    });
  }, 800);
}

function cancelCalibration() {
  isDynamicCalibrating = false;
  dynamicSamples = [];
  cleanupOverlay();
  loadProfile();
  updateStatusUI();
  isCalibrating = false;
  window.removeEventListener("keydown", handleGlobalKeyDown);
}

function createCalibrationOverlay() {
  if (document.getElementById("calibration-overlay")) return;

  const overlay = document.createElement("div");
  overlay.id = "calibration-overlay";
  overlay.className = "calibration-overlay";
  overlay.innerHTML = `
    <div id="calibration-instruction" class="calibration-instruction">
      Olhe fixamente para o ponto e pressione Espaço ou clique
    </div>
    <button id="btn-cancel-calibration" class="btn btn-secondary cancel-btn">Cancelar</button>
  `;
  document.body.appendChild(overlay);

  overlay.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).id === "btn-cancel-calibration") return;
    startCollection();
  });
  document.getElementById("btn-cancel-calibration")?.addEventListener("click", (e) => {
    e.stopPropagation();
    cancelCalibration();
  });
}

function cleanupOverlay() {
  document.getElementById("calibration-overlay")?.remove();
}

function showNextPoint() {
  const overlay = document.getElementById("calibration-overlay");
  if (!overlay) return;

  document.getElementById("calibration-dot")?.remove();

  const point = TARGET_POINTS[currentPointIndex];
  const dot = document.createElement("div");
  dot.id = "calibration-dot";
  dot.className = "calibration-dot";
  dot.style.left = `${point.screenX * 100}vw`;
  dot.style.top  = `${point.screenY * 100}vh`;
  dot.innerHTML = `
    <div class="dot-inner"></div>
    <div class="dot-pulse"></div>
    <svg class="countdown-ring" viewBox="0 0 56 56" xmlns="http://www.w3.org/2000/svg">
      <circle class="ring-track" cx="28" cy="28" r="24"/>
      <circle class="ring-fill"  cx="28" cy="28" r="24"/>
    </svg>
  `;
  overlay.appendChild(dot);

  const instruction = document.getElementById("calibration-instruction");
  if (instruction) {
    instruction.innerHTML = `
      Olhe fixamente para o ponto <span class="highlight">${currentPointIndex + 1}/16</span><br>
      <span class="action-highlight">ESPAÇO</span> ou <span class="action-highlight">Clique</span> para capturar
    `;
  }
}

function startCollection() {
  if (isDynamicCalibrating || isCollecting || !isCalibrating) return;
  collectedRawX = [];
  collectedRawY = [];
  isCollecting = true;
  collectionStartTime = performance.now();

  const dot = document.getElementById("calibration-dot");
  if (dot) {
    dot.classList.remove("capturing", "unstable", "captured");
    void (dot as HTMLElement).offsetWidth;
    dot.classList.add("capturing");
  }
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
}

export function feedRawData(ratioX: number, dy: number) {
  if (isDynamicCalibrating) {
    dynamicSamples.push({
      screenX: dynamicBallX,
      screenY: dynamicBallY,
      rawX: ratioX,
      rawY: dy,
      weight: dynamicIsFixation ? 3.0 : 1.0
    });
    return;
  }

  if (!isCalibrating || !isCollecting) return;

  collectedRawX.push(ratioX);
  collectedRawY.push(dy);

  if (performance.now() - collectionStartTime >= COLLECTION_MS) {
    isCollecting = false;
    processStaticPoint();
  }
}

function processStaticPoint() {
  const isUnstable =
    stdDev(collectedRawX) > STD_THRESHOLD_X ||
    stdDev(collectedRawY) > STD_THRESHOLD_Y;

  if (isUnstable && unstableRetries < MAX_UNSTABLE_RETRIES) {
    unstableRetries++;
    showInstableWarning();
    return;
  }

  unstableRetries = 0;

  const avgX = collectedRawX.reduce((s, v) => s + v, 0) / collectedRawX.length;
  const avgY = collectedRawY.reduce((s, v) => s + v, 0) / collectedRawY.length;

  profile.push({
    screenX: TARGET_POINTS[currentPointIndex].screenX,
    screenY: TARGET_POINTS[currentPointIndex].screenY,
    rawX: avgX,
    rawY: avgY
  });

  currentPointIndex++;

  const dot = document.getElementById("calibration-dot");
  if (dot) {
    dot.classList.remove("capturing");
    dot.classList.add("captured");
  }

  setTimeout(() => {
    if (currentPointIndex < TARGET_POINTS.length) {
      showNextPoint();
    } else {
      transitionToDynamicPhase();
    }
  }, TRANSITION_MS);
}

function showInstableWarning() {
  const dot = document.getElementById("calibration-dot");
  if (dot) {
    dot.classList.remove("capturing");
    dot.classList.add("unstable");
  }

  const instruction = document.getElementById("calibration-instruction");
  if (instruction) {
    instruction.innerHTML = `
      <span class="warning-text">Movimento detectado — olhe fixamente e tente novamente</span><br>
      <span class="highlight">${currentPointIndex + 1}/16</span> &nbsp;
      <span class="action-highlight">ESPAÇO</span> ou <span class="action-highlight">Clique</span>
    `;
  }
}

function handleGlobalKeyDown(e: KeyboardEvent) {
  if (!isCalibrating || isCollecting || isDynamicCalibrating) return;
  if (e.code === "Space" || e.code === "Enter") {
    e.preventDefault();
    startCollection();
  }
}

// ── Fase 2: Calibração Dinâmica ──────────────────────────────────────────────

function transitionToDynamicPhase() {
  document.getElementById("calibration-dot")?.remove();

  const instruction = document.getElementById("calibration-instruction");
  if (instruction) {
    instruction.innerHTML = `
      <span class="phase-badge">Fase 1 concluída ✓</span>
      <p class="phase-sub">Preparando calibração dinâmica…</p>
    `;
  }

  setTimeout(startDynamicCalibration, 2000);
}

function startDynamicCalibration() {
  isDynamicCalibrating = true;
  dynamicSamples = [];

  const overlay = document.getElementById("calibration-overlay");
  if (!overlay) return;
  overlay.classList.add("dynamic-phase");

  const instruction = document.getElementById("calibration-instruction");
  if (instruction) {
    instruction.innerHTML = `
      <span class="phase-badge">Fase 2 / 2 — Calibração Dinâmica</span>
      <p class="phase-sub">Acompanhe a bolinha com os olhos suavemente</p>
    `;
  }

  const progressEl = document.createElement("div");
  progressEl.id = "dynamic-progress";
  progressEl.className = "dynamic-progress";
  DYNAMIC_WAYPOINTS.forEach((_, i) => {
    const d = document.createElement("div");
    d.className = "progress-dot" + (i === 0 ? " active" : "");
    d.id = `pdot-${i}`;
    progressEl.appendChild(d);
  });
  overlay.appendChild(progressEl);

  const ball = document.createElement("div");
  ball.id = "dynamic-ball";
  ball.className = "dynamic-ball";
  const wp0 = DYNAMIC_WAYPOINTS[0];
  ball.style.left = `${wp0.x * window.innerWidth}px`;
  ball.style.top  = `${wp0.y * window.innerHeight}px`;
  dynamicBallX = wp0.x;
  dynamicBallY = wp0.y;
  overlay.appendChild(ball);

  setTimeout(() => pulseBall(ball, () => runDynamicSequence(1)), 500);
}

function runDynamicSequence(index: number) {
  if (index >= DYNAMIC_WAYPOINTS.length) {
    completeDynamicCalibration();
    return;
  }

  const prev = document.getElementById(`pdot-${index - 1}`);
  if (prev) { prev.classList.remove("active"); prev.classList.add("done"); }
  const curr = document.getElementById(`pdot-${index}`);
  if (curr) curr.classList.add("active");

  const ball = document.getElementById("dynamic-ball") as HTMLElement | null;
  if (!ball) return;

  moveBallSmoothly(ball, DYNAMIC_WAYPOINTS[index], () => {
    pulseBall(ball, () => runDynamicSequence(index + 1));
  });
}

function moveBallSmoothly(
  ball: HTMLElement,
  target: { x: number; y: number },
  onComplete: () => void
) {
  const startX = dynamicBallX * window.innerWidth;
  const startY = dynamicBallY * window.innerHeight;
  const endX   = target.x * window.innerWidth;
  const endY   = target.y * window.innerHeight;
  const t0     = performance.now();

  dynamicIsFixation = false;

  function frame() {
    const t = Math.min((performance.now() - t0) / DYN_MOVE_MS, 1.0);
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

    dynamicBallX = (startX + (endX - startX) * e) / window.innerWidth;
    dynamicBallY = (startY + (endY - startY) * e) / window.innerHeight;
    ball.style.left = `${dynamicBallX * window.innerWidth}px`;
    ball.style.top  = `${dynamicBallY * window.innerHeight}px`;

    if (t < 1.0) {
      requestAnimationFrame(frame);
    } else {
      dynamicBallX = target.x;
      dynamicBallY = target.y;
      onComplete();
    }
  }

  requestAnimationFrame(frame);
}

function pulseBall(ball: HTMLElement, onComplete: () => void) {
  dynamicIsFixation = true;
  ball.classList.remove("pulsing");
  void ball.offsetWidth;
  ball.classList.add("pulsing");

  setTimeout(() => {
    ball.classList.remove("pulsing");
    dynamicIsFixation = false;
    onComplete();
  }, DYN_PULSE_MS);
}

function completeDynamicCalibration() {
  isDynamicCalibrating = false;

  // Inclui APENAS samples de fixação (w>1.5) com peso reduzido para 0.5.
  // Samples de movimento (w=1.0) são excluídos porque:
  //   • Introduzem viés de lag de perseguição (~55px em X, ~20px em Y com lag=200ms)
  //   • O snake path tem assimetria estrutural: 4 segmentos rightward vs 2 leftward
  //     e 2 downward sem nenhum upward — viés em Y não se cancela
  // Mesmo os samples de fixação têm ruído 5× maior que os pontos estáticos (SEM);
  // o peso 0.5 mantém sua contribuição ≤4% do peso total, evitando diluição do fit.
  const fixationOnly = dynamicSamples
    .filter(s => s.weight > 1.5)
    .map(s => ({ ...s, weight: 0.5 }));
  retrainRidgeModel(fixationOnly);
  saveProfile();
  cleanupOverlay();
  isCalibrating = false;
  window.removeEventListener("keydown", handleGlobalKeyDown);
  runAccuracyTest();
}

// ── Painel de Controle ───────────────────────────────────────────────────────

export function createControlPanel() {
  if (document.getElementById("calibration-control-panel")) return;

  const panel = document.createElement("div");
  panel.id = "calibration-control-panel";
  panel.className = "calibration-control-panel";
  panel.innerHTML = `
    <div class="panel-header">Calibração Ocular</div>
    <div class="panel-status">
      Status: <span id="calibration-status-badge" class="badge">Não Calibrado</span>
    </div>
    <div id="accuracy-result-area"></div>
    <div class="panel-actions">
      <button id="btn-start-calibration" class="btn btn-primary">Iniciar</button>
      <button id="btn-clear-calibration" class="btn btn-secondary">Limpar</button>
    </div>
  `;
  document.body.appendChild(panel);

  document.getElementById("btn-start-calibration")?.addEventListener("click", startCalibrationMode);
  document.getElementById("btn-clear-calibration")?.addEventListener("click", clearCalibration);
}

export function updateStatusUI(accuracyResult?: { meanError: number; maxError: number; score: string; colorClass: string }) {
  const badge    = document.getElementById("calibration-status-badge");
  const clearBtn = document.getElementById("btn-clear-calibration") as HTMLButtonElement;

  if (badge) {
    if (isCalibrated()) {
      badge.innerText = "Calibrado";
      badge.className = "badge status-calibrated";
      if (clearBtn) clearBtn.disabled = false;
    } else {
      badge.innerText = "Não Calibrado";
      badge.className = "badge status-uncalibrated";
      if (clearBtn) clearBtn.disabled = true;
      const area = document.getElementById("accuracy-result-area");
      if (area) area.innerHTML = "";
    }
  }

  if (accuracyResult) {
    const area = document.getElementById("accuracy-result-area");
    if (area) {
      area.innerHTML = `
        <div class="accuracy-result ${accuracyResult.colorClass}">
          <div class="accuracy-label">Precisão</div>
          <div class="accuracy-score">${accuracyResult.score}</div>
          <div class="accuracy-detail">Erro médio: <strong>${Math.round(accuracyResult.meanError)}px</strong></div>
          <div class="accuracy-detail">Erro máximo: <strong>${Math.round(accuracyResult.maxError)}px</strong></div>
        </div>
      `;
    }
  }
}

export function init() {
  loadProfile();
  createControlPanel();
  updateStatusUI();
  try {
    const saved = localStorage.getItem("accuracyResult");
    if (saved && isCalibrated()) updateStatusUI(JSON.parse(saved));
  } catch (_) {}
}

// ── Mapeamento de Olhar (Ridge Regression) ───────────────────────────────────

// Substitui a interpolação bilinear por regressão ridge com base polinomial grau 2.
// Vantagens sobre a bilinear:
//   • Regularização L2 amortece o ruído de qualquer ponto de calibração individual,
//     em vez de "gravar" o erro na malha permanentemente.
//   • Função suave (C∞) — sem descontinuidades de gradiente nas bordas de células,
//     eliminando o "salto" do cursor ao cruzar fronteiras de grade.
//   • Incorpora amostras dinâmicas com pesos no ajuste global, não só nos 16 vértices.
//   • Lambda selecionado por LOOCV shortcut — adaptativo à qualidade da calibração.
export function mapGaze(ratioX: number, dy: number): { x: number; y: number } | null {
  if (!ridgeCoefX || !ridgeCoefY) return null;

  const f    = buildFeatures(ratioX, dy);
  const normX = Math.min(Math.max(ridgeCoefX.reduce((s, c, i) => s + c * f[i], 0), 0), 1);
  const normY = Math.min(Math.max(ridgeCoefY.reduce((s, c, i) => s + c * f[i], 0), 0), 1);

  return {
    x: normX * window.innerWidth,
    y: normY * window.innerHeight,
  };
}
