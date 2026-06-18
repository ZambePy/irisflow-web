interface CalibrationPoint {
  screenX: number; // Coordenada X normalizada da tela (0.1, 0.5, 0.9)
  screenY: number; // Coordenada Y normalizada da tela (0.1, 0.5, 0.9)
  rawX: number;    // Coordenada ratioX crua dos olhos
  rawY: number;    // Coordenada dy crua dos olhos
}

const TARGET_POINTS = [
  { name: "Superior Esquerdo", screenX: 0.1, screenY: 0.1 },
  { name: "Superior Centro",   screenX: 0.5, screenY: 0.1 },
  { name: "Superior Direito",  screenX: 0.9, screenY: 0.1 },
  { name: "Médio Esquerdo",    screenX: 0.1, screenY: 0.5 },
  { name: "Centro",            screenX: 0.5, screenY: 0.5 },
  { name: "Médio Direito",     screenX: 0.9, screenY: 0.5 },
  { name: "Inferior Esquerdo", screenX: 0.1, screenY: 0.9 },
  { name: "Inferior Centro",   screenX: 0.5, screenY: 0.9 },
  { name: "Inferior Direito",  screenX: 0.9, screenY: 0.9 }
];

let profile: CalibrationPoint[] = [];
export let isCalibrating = false;
let currentPointIndex = 0;
let isCollecting = false;
let collectionStartTime = 0;
let collectedRawX: number[] = [];
let collectedRawY: number[] = [];

// Carrega o perfil do localStorage
export function loadProfile(): boolean {
  try {
    const saved = localStorage.getItem("calibrationProfile");
    if (saved) {
      profile = JSON.parse(saved);
      if (profile.length === 9) {
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
  updateStatusUI();
}

// Retorna se o usuário está calibrado
export function isCalibrated(): boolean {
  return profile.length === 9;
}

// Inicia o processo de calibração
export function startCalibrationMode() {
  if (isCalibrating) return;
  isCalibrating = true;
  currentPointIndex = 0;
  isCollecting = false;
  profile = [];
  
  createCalibrationOverlay();
  showNextPoint();
  
  // Adiciona evento de teclado global para espaço/enter
  window.addEventListener("keydown", handleGlobalKeyDown);
}

// Finaliza a calibração
function finishCalibration() {
  saveProfile();
  cleanupOverlay();
  updateStatusUI();
  isCalibrating = false;
  window.removeEventListener("keydown", handleGlobalKeyDown);
}

// Cancela a calibração em andamento
function cancelCalibration() {
  cleanupOverlay();
  loadProfile(); // Restaura perfil anterior se houver
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

  // Clicar em qualquer lugar do overlay inicia a captura
  overlay.addEventListener("click", (e) => {
    // Evita acionar se clicar no botão de cancelar
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
      Olhe fixamente para o ponto <span class="highlight">${currentPointIndex + 1}/9</span><br>
      e <span class="action-highlight">Pressione ESPAÇO</span> ou <span class="action-highlight">Clique</span>
    `;
  }
}

// Inicia a captura de dados
function startCollection() {
  if (isCollecting || !isCalibrating) return;
  collectedRawX = [];
  collectedRawY = [];
  isCollecting = true;
  collectionStartTime = performance.now();
  
  const dot = document.getElementById("calibration-dot");
  if (dot) {
    dot.classList.add("capturing");
  }
}

// Captura as coordenadas cruas a cada frame se estiver no ciclo de coleta
export function feedRawData(ratioX: number, dy: number) {
  if (!isCalibrating || !isCollecting) return;

  collectedRawX.push(ratioX);
  collectedRawY.push(dy);

  const elapsed = performance.now() - collectionStartTime;

  // Feedback visual durante a captura (reduz tamanho/aumenta brilho)
  const dot = document.getElementById("calibration-dot");
  if (dot) {
    const progress = Math.min(elapsed / 500, 1);
    dot.style.transform = `translate(-50%, -50%) scale(${1 - progress * 0.5})`;
    dot.style.boxShadow = `0 0 ${15 + progress * 25}px rgba(0, 255, 240, 0.8)`;
  }

  // Quando completa 500ms de amostragem
  if (elapsed >= 500) {
    isCollecting = false;

    // Calcula a média das coordenadas cruas coletadas nesse intervalo
    const avgX = collectedRawX.reduce((sum, val) => sum + val, 0) / collectedRawX.length;
    const avgY = collectedRawY.reduce((sum, val) => sum + val, 0) / collectedRawY.length;

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

// Atualiza o distintivo de status
export function updateStatusUI() {
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
    }
  }
}

// Inicializa o módulo
export function init() {
  loadProfile();
  createControlPanel();
  updateStatusUI();
}

// Realiza o mapeamento de coordenadas (Interpolação Bilinear por Quadrantes)
export function mapGaze(ratioX: number, dy: number): { x: number, y: number } | null {
  if (profile.length !== 9) return null;

  const lerpVal = (start: number, end: number, factor: number) => start + (end - start) * factor;
  const clampVal = (val: number, min: number, max: number) => Math.min(Math.max(val, min), max);
  const mapRangeVal = (val: number, inMin: number, inMax: number, outMin: number, outMax: number) => {
    if (Math.abs(inMax - inMin) < 1e-6) return outMin;
    return (val - inMin) * (outMax - outMin) / (inMax - inMin) + outMin;
  };

  // Pontos ordenados na grade 3x3:
  // 0: TL, 1: TC, 2: TR
  // 3: ML, 4: C,  5: MR
  // 6: BL, 7: BC, 8: BR
  const pt = profile;

  // Auxiliar para obter o X cru em um Y cru ao longo de uma coluna vertical
  function getXAtY(y: number, ptA: CalibrationPoint, ptB: CalibrationPoint): number {
    if (Math.abs(ptA.rawY - ptB.rawY) < 1e-6) return ptA.rawX;
    const t = clampVal((y - ptA.rawY) / (ptB.rawY - ptA.rawY), 0, 1);
    return lerpVal(ptA.rawX, ptB.rawX, t);
  }

  // Auxiliar para obter o Y cru em um X cru ao longo de uma linha horizontal
  function getYAtX(x: number, ptA: CalibrationPoint, ptB: CalibrationPoint): number {
    if (Math.abs(ptA.rawX - ptB.rawX) < 1e-6) return ptA.rawY;
    const t = clampVal((x - ptA.rawX) / (ptB.rawX - ptA.rawX), 0, 1);
    return lerpVal(ptA.rawY, ptB.rawY, t);
  }

  // Interpola a posição horizontal das colunas no Y atual
  let rawLeftX = dy < pt[3].rawY ? getXAtY(dy, pt[0], pt[3]) : getXAtY(dy, pt[3], pt[6]);
  let rawCenterX = dy < pt[4].rawY ? getXAtY(dy, pt[1], pt[4]) : getXAtY(dy, pt[4], pt[7]);
  let rawRightX = dy < pt[5].rawY ? getXAtY(dy, pt[2], pt[5]) : getXAtY(dy, pt[5], pt[8]);

  // Mapeia o X cru para a tela (em frações de 0.0 a 1.0)
  let normX: number;
  if (ratioX < rawCenterX) {
    normX = mapRangeVal(ratioX, rawLeftX, rawCenterX, 0.1, 0.5);
  } else {
    normX = mapRangeVal(ratioX, rawCenterX, rawRightX, 0.5, 0.9);
  }

  // Interpola a posição vertical das linhas no X atual
  let rawTopY = ratioX < pt[1].rawX ? getYAtX(ratioX, pt[0], pt[1]) : getYAtX(ratioX, pt[1], pt[2]);
  let rawMiddleY = ratioX < pt[4].rawX ? getYAtX(ratioX, pt[3], pt[4]) : getYAtX(ratioX, pt[4], pt[5]);
  let rawBottomY = ratioX < pt[7].rawX ? getYAtX(ratioX, pt[6], pt[7]) : getYAtX(ratioX, pt[7], pt[8]);

  // Mapeia o Y cru para a tela (em frações de 0.0 a 1.0)
  let normY: number;
  if (dy < rawMiddleY) {
    normY = mapRangeVal(dy, rawTopY, rawMiddleY, 0.1, 0.5);
  } else {
    normY = mapRangeVal(dy, rawMiddleY, rawBottomY, 0.5, 0.9);
  }

  // Limita as coordenadas à janela da tela
  normX = clampVal(normX, 0, 1);
  normY = clampVal(normY, 0, 1);

  return {
    x: normX * window.innerWidth,
    y: normY * window.innerHeight
  };
}
