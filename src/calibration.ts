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

const GRID_NORM = [0.0, 0.333, 0.667, 1.0];

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

export function loadProfile(): boolean {
  try {
    const saved = localStorage.getItem("calibrationProfile");
    if (saved) {
      profile = JSON.parse(saved);
      if (profile.length === 16) return true;
    }
  } catch (e) {
    console.error("Erro ao carregar calibrationProfile:", e);
  }
  profile = [];
  return false;
}

function saveProfile() {
  localStorage.setItem("calibrationProfile", JSON.stringify(profile));
}

export function clearCalibration() {
  profile = [];
  localStorage.removeItem("calibrationProfile");
  localStorage.removeItem("accuracyResult");
  updateStatusUI();
}

export function isCalibrated(): boolean {
  return profile.length === 16;
}

export function startCalibrationMode() {
  if (isCalibrating) return;
  isCalibrating = true;
  currentPointIndex = 0;
  isCollecting = false;
  unstableRetries = 0;
  profile = [];

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

  // Indicador de progresso
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

  // Bolinha no primeiro waypoint
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
  if (dynamicSamples.length >= 20) refineDynamicProfile();
  saveProfile();
  cleanupOverlay();
  isCalibrating = false;
  window.removeEventListener("keydown", handleGlobalKeyDown);
  runAccuracyTest();
}

function refineDynamicProfile() {
  const SIGMA    = 0.15;
  const MAX_DIST = 0.35;

  for (const pt of profile) {
    let totalW = 0, sumX = 0, sumY = 0;

    for (const s of dynamicSamples) {
      const dx   = s.screenX - pt.screenX;
      const dy   = s.screenY - pt.screenY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > MAX_DIST) continue;
      const w = Math.exp(-(dist * dist) / (2 * SIGMA * SIGMA)) * s.weight;
      totalW += w;
      sumX   += s.rawX * w;
      sumY   += s.rawY * w;
    }

    if (totalW > 5) {
      // Influência dinâmica conservadora: máximo 30% de ajuste
      const alpha = Math.min((totalW - 5) / 200, 0.30);
      pt.rawX = pt.rawX * (1 - alpha) + (sumX / totalW) * alpha;
      pt.rawY = pt.rawY * (1 - alpha) + (sumY / totalW) * alpha;
    }
  }
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

// ── Mapeamento de Olhar (bilinear 4×4) ───────────────────────────────────────

export function mapGaze(ratioX: number, dy: number): { x: number; y: number } | null {
  if (profile.length !== 16) return null;

  const lerpVal     = (a: number, b: number, t: number) => a + (b - a) * t;
  const clampVal    = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
  const mapRangeVal = (v: number, iMin: number, iMax: number, oMin: number, oMax: number) => {
    if (Math.abs(iMax - iMin) < 1e-6) return oMin;
    return (v - iMin) * (oMax - oMin) / (iMax - iMin) + oMin;
  };

  const pt = profile;

  function getColRawX(col: number, y: number): number {
    const rows = [pt[col], pt[col + 4], pt[col + 8], pt[col + 12]];
    for (let i = 0; i < 3; i++) {
      const a = rows[i], b = rows[i + 1];
      if (y <= Math.max(a.rawY, b.rawY) || i === 2) {
        if (Math.abs(a.rawY - b.rawY) < 1e-6) return a.rawX;
        return lerpVal(a.rawX, b.rawX, clampVal((y - a.rawY) / (b.rawY - a.rawY), 0, 1));
      }
    }
    return rows[0].rawX;
  }

  function getRowRawY(row: number, x: number): number {
    const cols = [pt[row * 4], pt[row * 4 + 1], pt[row * 4 + 2], pt[row * 4 + 3]];
    for (let i = 0; i < 3; i++) {
      const a = cols[i], b = cols[i + 1];
      if (x <= Math.max(a.rawX, b.rawX) || i === 2) {
        if (Math.abs(a.rawX - b.rawX) < 1e-6) return a.rawY;
        return lerpVal(a.rawY, b.rawY, clampVal((x - a.rawX) / (b.rawX - a.rawX), 0, 1));
      }
    }
    return cols[0].rawY;
  }

  const c0 = getColRawX(0, dy), c1 = getColRawX(1, dy);
  const c2 = getColRawX(2, dy), c3 = getColRawX(3, dy);

  let normX: number;
  if      (ratioX <= c1) normX = mapRangeVal(ratioX, c0, c1, GRID_NORM[0], GRID_NORM[1]);
  else if (ratioX <= c2) normX = mapRangeVal(ratioX, c1, c2, GRID_NORM[1], GRID_NORM[2]);
  else                   normX = mapRangeVal(ratioX, c2, c3, GRID_NORM[2], GRID_NORM[3]);

  const r0 = getRowRawY(0, ratioX), r1 = getRowRawY(1, ratioX);
  const r2 = getRowRawY(2, ratioX), r3 = getRowRawY(3, ratioX);

  let normY: number;
  if      (dy <= r1) normY = mapRangeVal(dy, r0, r1, GRID_NORM[0], GRID_NORM[1]);
  else if (dy <= r2) normY = mapRangeVal(dy, r1, r2, GRID_NORM[1], GRID_NORM[2]);
  else               normY = mapRangeVal(dy, r2, r3, GRID_NORM[2], GRID_NORM[3]);

  return {
    x: clampVal(normX, 0, 1) * window.innerWidth,
    y: clampVal(normY, 0, 1) * window.innerHeight
  };
}
