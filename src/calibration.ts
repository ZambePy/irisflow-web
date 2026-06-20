interface CalibrationPoint {
  screenX: number; // Coordenada X normalizada da tela (0.03 a 0.97)
  screenY: number; // Coordenada Y normalizada da tela (0.03 a 0.97)
  rawX: number;    // Coordenada ratioX crua dos olhos
  rawY: number;    // Coordenada dy crua dos olhos
}

// Grade 4x4: X ∈ {0.03, 0.35, 0.65, 0.97}, Y ∈ {0.03, 0.35, 0.65, 0.97}
// Cobre toda a tela incluindo cantos (0.0–1.0), com 78% mais pontos que o grid 3x3 anterior
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

// Posições normalizadas do grid na tela (4 colunas e 4 linhas)
const GRID_NORM = [0.0, 0.333, 0.667, 1.0];

let profile: CalibrationPoint[] = [];
export let isCalibrating = false;
let currentPointIndex = 0;
let isCollecting = false;
let collectionStartTime = 0;
let collectedRawX: number[] = [];
let collectedRawY: number[] = [];
let unstableRetries = 0;

// Threshold de desvio-padrão derivado dos intervalos típicos:
// ratioX ≈ 0.35–0.65 → std aceitável < 0.015
// dy ≈ -0.07–0.07    → std aceitável < 0.010
const STD_THRESHOLD_X = 0.015;
const STD_THRESHOLD_Y = 0.010;
const MAX_UNSTABLE_RETRIES = 2;

// Carrega o perfil do localStorage
export function loadProfile(): boolean {
  try {
    const saved = localStorage.getItem("calibrationProfile");
    if (saved) {
      profile = JSON.parse(saved);
      if (profile.length === 16) {
        return true;
      }
    }
  } catch (e) {
    console.error("Erro ao carregar calibrationProfile:", e);
  }
  profile = [];
  return false;
}

// Salva o perfil no localStorage
function saveProfile() {
  localStorage.setItem("calibrationProfile", JSON.stringify(profile));
}

// Limpa o perfil
export function clearCalibration() {
  profile = [];
  localStorage.removeItem("calibrationProfile");
  localStorage.removeItem("accuracyResult");
  updateStatusUI();
}

// Retorna se o usuário está calibrado
export function isCalibrated(): boolean {
  return profile.length === 16;
}

// Inicia o processo de calibração
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

// Finaliza a calibração — salva e dispara teste de precisão
function finishCalibration() {
  saveProfile();
  cleanupOverlay();
  isCalibrating = false;
  window.removeEventListener("keydown", handleGlobalKeyDown);

  // Dispara análise de precisão após breve pausa para o usuário se reorientar
  setTimeout(() => {
    import('./accuracy').then(({ startAccuracyTest }) => {
      startAccuracyTest((result) => {
        updateStatusUI(result);
      });
    });
  }, 800);
}

// Cancela a calibração em andamento
function cancelCalibration() {
  cleanupOverlay();
  loadProfile();
  updateStatusUI();
  isCalibrating = false;
  window.removeEventListener("keydown", handleGlobalKeyDown);
}

// Cria o overlay HTML da calibração
function createCalibrationOverlay() {
  if (document.getElementById("calibration-overlay")) return;

  const overlay = document.createElement("div");
  overlay.id = "calibration-overlay";
  overlay.className = "calibration-overlay";

  overlay.innerHTML = `
    <div id="calibration-instruction" class="calibration-instruction">
      Olhe fixamente para o ponto e clique em qualquer lugar (ou aperte Espaço) para calibrar
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

// Remove o overlay do DOM
function cleanupOverlay() {
  const overlay = document.getElementById("calibration-overlay");
  if (overlay) overlay.remove();
}

// Cria o ponto visual na tela
function showNextPoint() {
  const overlay = document.getElementById("calibration-overlay");
  if (!overlay) return;

  const oldDot = document.getElementById("calibration-dot");
  if (oldDot) oldDot.remove();

  const point = TARGET_POINTS[currentPointIndex];

  const dot = document.createElement("div");
  dot.id = "calibration-dot";
  dot.className = "calibration-dot";
  dot.style.left = `${point.screenX * 100}vw`;
  dot.style.top = `${point.screenY * 100}vh`;

  dot.innerHTML = `
    <div class="dot-inner"></div>
    <div class="dot-pulse"></div>
  `;

  overlay.appendChild(dot);

  const instruction = document.getElementById("calibration-instruction");
  if (instruction) {
    instruction.innerHTML = `
      Olhe fixamente para o ponto <span class="highlight">${currentPointIndex + 1}/16</span><br>
      e <span class="action-highlight">Pressione ESPAÇO</span> ou <span class="action-highlight">Clique</span>
    `;
  }
}

// Inicia a captura de dados para o ponto atual
function startCollection() {
  if (isCollecting || !isCalibrating) return;
  collectedRawX = [];
  collectedRawY = [];
  isCollecting = true;
  collectionStartTime = performance.now();

  const dot = document.getElementById("calibration-dot");
  if (dot) {
    dot.classList.add("capturing");
    dot.classList.remove("unstable");
  }
}

// Calcula o desvio-padrão de um array de números
function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

// Captura as coordenadas cruas a cada frame se estiver no ciclo de coleta
export function feedRawData(ratioX: number, dy: number) {
  if (!isCalibrating || !isCollecting) return;

  collectedRawX.push(ratioX);
  collectedRawY.push(dy);

  const elapsed = performance.now() - collectionStartTime;

  const dot = document.getElementById("calibration-dot");
  if (dot) {
    const progress = Math.min(elapsed / 500, 1);
    dot.style.transform = `translate(-50%, -50%) scale(${1 - progress * 0.5})`;
    dot.style.boxShadow = `0 0 ${15 + progress * 25}px rgba(0, 255, 240, 0.8)`;
  }

  if (elapsed >= 500) {
    isCollecting = false;

    // Filtro de fixação (inspirado em EyeGestures fixation.py):
    // rejeita amostras com desvio-padrão alto (piscadas, sacadas)
    const sX = stdDev(collectedRawX);
    const sY = stdDev(collectedRawY);
    const isUnstable = sX > STD_THRESHOLD_X || sY > STD_THRESHOLD_Y;

    if (isUnstable && unstableRetries < MAX_UNSTABLE_RETRIES) {
      unstableRetries++;
      showInstableWarning();
      return;
    }

    unstableRetries = 0;

    const avgX = collectedRawX.reduce((s, v) => s + v, 0) / collectedRawX.length;
    const avgY = collectedRawY.reduce((s, v) => s + v, 0) / collectedRawY.length;

    const currentPoint = TARGET_POINTS[currentPointIndex];
    profile.push({
      screenX: currentPoint.screenX,
      screenY: currentPoint.screenY,
      rawX: avgX,
      rawY: avgY
    });

    currentPointIndex++;
    if (currentPointIndex < TARGET_POINTS.length) {
      showNextPoint();
    } else {
      finishCalibration();
    }
  }
}

// Feedback visual e instrução para repetir ponto instável
function showInstableWarning() {
  const dot = document.getElementById("calibration-dot");
  if (dot) {
    dot.classList.remove("capturing");
    dot.classList.add("unstable");
    dot.style.transform = "translate(-50%, -50%) scale(1)";
    dot.style.boxShadow = "";
  }

  const instruction = document.getElementById("calibration-instruction");
  if (instruction) {
    instruction.innerHTML = `
      <span class="warning-text">Movimento detectado — olhe fixamente e tente novamente</span><br>
      <span class="highlight">${currentPointIndex + 1}/16</span> &nbsp;
      <span class="action-highlight">Pressione ESPAÇO</span> ou <span class="action-highlight">Clique</span>
    `;
  }
}

// Manipula a tecla de atalho para captura
function handleGlobalKeyDown(e: KeyboardEvent) {
  if (!isCalibrating || isCollecting) return;
  if (e.code === "Space" || e.code === "Enter") {
    e.preventDefault();
    startCollection();
  }
}

// Cria o painel de controle na tela
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

  document.getElementById("btn-start-calibration")?.addEventListener("click", () => {
    startCalibrationMode();
  });

  document.getElementById("btn-clear-calibration")?.addEventListener("click", () => {
    clearCalibration();
  });
}

// Atualiza o distintivo de status e, opcionalmente, o resultado de precisão
export function updateStatusUI(accuracyResult?: { meanError: number; maxError: number; score: string; colorClass: string }) {
  const badge = document.getElementById("calibration-status-badge");
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
      // Limpa resultado de precisão ao desafibrar
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

// Inicializa o módulo
export function init() {
  loadProfile();
  createControlPanel();
  updateStatusUI();

  // Restaura resultado de precisão salvo se houver
  try {
    const saved = localStorage.getItem("accuracyResult");
    if (saved && isCalibrated()) {
      updateStatusUI(JSON.parse(saved));
    }
  } catch (_) {}
}

// Realiza o mapeamento de coordenadas (Interpolação Bilinear em Grade 4×4 — 3 segmentos por eixo)
// Grade: colunas/linhas em índices 0–3 mapeadas para GRID_NORM = [0.0, 0.333, 0.667, 1.0]
export function mapGaze(ratioX: number, dy: number): { x: number, y: number } | null {
  if (profile.length !== 16) return null;

  const lerpVal = (a: number, b: number, t: number) => a + (b - a) * t;
  const clampVal = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
  const mapRangeVal = (v: number, iMin: number, iMax: number, oMin: number, oMax: number) => {
    if (Math.abs(iMax - iMin) < 1e-6) return oMin;
    return (v - iMin) * (oMax - oMin) / (iMax - iMin) + oMin;
  };

  // Layout do perfil em grade 4×4 (linha-por-linha, esquerda para direita):
  // linha 0: pt[0..3]  (Y mais alto / topo)
  // linha 1: pt[4..7]
  // linha 2: pt[8..11]
  // linha 3: pt[12..15] (Y mais baixo / rodapé)
  const pt = profile;

  // Interpola o valor rawX de cada coluna ao longo do Y atual
  function getColRawX(col: number, y: number): number {
    const rows = [pt[col], pt[col + 4], pt[col + 8], pt[col + 12]];
    // Encontra o segmento vertical que contém y
    for (let i = 0; i < 3; i++) {
      const a = rows[i];
      const b = rows[i + 1];
      const yMin = Math.min(a.rawY, b.rawY);
      const yMax = Math.max(a.rawY, b.rawY);
      if (y <= yMax || i === 2) {
        if (Math.abs(a.rawY - b.rawY) < 1e-6) return a.rawX;
        const t = clampVal((y - a.rawY) / (b.rawY - a.rawY), 0, 1);
        return lerpVal(a.rawX, b.rawX, t);
      }
    }
    return rows[0].rawX;
  }

  // Interpola o valor rawY de cada linha ao longo do X atual
  function getRowRawY(row: number, x: number): number {
    const cols = [pt[row * 4], pt[row * 4 + 1], pt[row * 4 + 2], pt[row * 4 + 3]];
    for (let i = 0; i < 3; i++) {
      const a = cols[i];
      const b = cols[i + 1];
      if (x <= Math.max(a.rawX, b.rawX) || i === 2) {
        if (Math.abs(a.rawX - b.rawX) < 1e-6) return a.rawY;
        const t = clampVal((x - a.rawX) / (b.rawX - a.rawX), 0, 1);
        return lerpVal(a.rawY, b.rawY, t);
      }
    }
    return cols[0].rawY;
  }

  // Valores raw nas 4 colunas para o dy atual
  const rawCol0 = getColRawX(0, dy);
  const rawCol1 = getColRawX(1, dy);
  const rawCol2 = getColRawX(2, dy);
  const rawCol3 = getColRawX(3, dy);

  // Mapeia ratioX para normX usando o segmento correto (3 segmentos)
  let normX: number;
  if (ratioX <= rawCol1) {
    normX = mapRangeVal(ratioX, rawCol0, rawCol1, GRID_NORM[0], GRID_NORM[1]);
  } else if (ratioX <= rawCol2) {
    normX = mapRangeVal(ratioX, rawCol1, rawCol2, GRID_NORM[1], GRID_NORM[2]);
  } else {
    normX = mapRangeVal(ratioX, rawCol2, rawCol3, GRID_NORM[2], GRID_NORM[3]);
  }

  // Valores raw nas 4 linhas para o ratioX atual
  const rawRow0 = getRowRawY(0, ratioX);
  const rawRow1 = getRowRawY(1, ratioX);
  const rawRow2 = getRowRawY(2, ratioX);
  const rawRow3 = getRowRawY(3, ratioX);

  // Mapeia dy para normY usando o segmento correto (3 segmentos)
  let normY: number;
  if (dy <= rawRow1) {
    normY = mapRangeVal(dy, rawRow0, rawRow1, GRID_NORM[0], GRID_NORM[1]);
  } else if (dy <= rawRow2) {
    normY = mapRangeVal(dy, rawRow1, rawRow2, GRID_NORM[1], GRID_NORM[2]);
  } else {
    normY = mapRangeVal(dy, rawRow2, rawRow3, GRID_NORM[2], GRID_NORM[3]);
  }

  normX = clampVal(normX, 0, 1);
  normY = clampVal(normY, 0, 1);

  return {
    x: normX * window.innerWidth,
    y: normY * window.innerHeight
  };
}
