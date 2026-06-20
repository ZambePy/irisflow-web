/**
 * Harness de comparação: bilinear (HEAD) vs ridge (novo) + análise de viés de lag de perseguição.
 *
 * Dados sintéticos com ground truth quadrática + ruído realista de webcam.
 * Não depende do browser — usa coordenadas normalizadas (0-1) ao longo de todo o pipeline.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// 1. MODELO DE GROUND TRUTH (tela → raw)
//    Função quadrática com acoplamento cruzado — representativa do eye tracking
//    via webcam onde a projeção da íris na câmera tem curvatura não-linear.
// ═══════════════════════════════════════════════════════════════════════════════

function trueRawX(sX: number, sY: number): number {
  // Dominante horizontal, curvatura em barril leve, acoplamento cruzado sutil
  return (
    0.65
    - 0.30  * sX
    - 0.030 * (sY - 0.5)
    + 0.025 * (sX - 0.5) ** 2
    - 0.010 * (sY - 0.5) ** 2
  );
}

function trueRawY(sX: number, sY: number): number {
  // Dominante vertical, curvatura em almofada leve, acoplamento cruzado sutil
  return (
    -0.050
    + 0.120 * sY
    + 0.012 * (sX - 0.5)
    + 0.018 * (sY - 0.5) ** 2
    - 0.007 * (sX - 0.5) ** 2
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. GERADOR DE RUÍDO (Gaussian seeded)
// ═══════════════════════════════════════════════════════════════════════════════

let _seed = 42;
function rand(): number {
  // LCG simples — determinístico entre execuções
  _seed = (_seed * 1664525 + 1013904223) & 0xffffffff;
  return ((_seed >>> 0) / 0xffffffff);
}
function randn(): number {
  // Box-Muller
  const u = Math.max(rand(), 1e-9);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. PONTOS DE CALIBRAÇÃO ESTÁTICOS (16 pontos, grid 4×4)
//    Cada ponto: média de N_AVG frames com ruído std=FRAME_STD.
//    SEM ≈ FRAME_STD / sqrt(N_AVG) — equivale ao filtro STD_THRESHOLD do código real.
// ═══════════════════════════════════════════════════════════════════════════════

const SCREEN_GRID = [0.03, 0.35, 0.65, 0.97];
const N_AVG       = 30;    // frames médios por ponto de calibração
const FRAME_STD   = 0.013; // desvio-padrão por frame (próximo ao STD_THRESHOLD_X=0.015)
const SEM         = FRAME_STD / Math.sqrt(N_AVG); // ~0.0024 — ruído de medição por ponto

interface CalibrationPoint {
  screenX: number; screenY: number;
  rawX: number;    rawY: number;
}

function generateStaticProfile(biasX = 0, biasY = 0): CalibrationPoint[] {
  const pts: CalibrationPoint[] = [];
  for (const sY of SCREEN_GRID) {
    for (const sX of SCREEN_GRID) {
      // Simula a média de N_AVG frames: equivale a N(true, SEM)
      pts.push({
        screenX: sX,
        screenY: sY,
        rawX: trueRawX(sX, sY) + randn() * SEM + biasX,
        rawY: trueRawY(sX, sY) + randn() * SEM + biasY,
      });
    }
  }
  return pts;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4. AMOSTRAS DINÂMICAS (snake path, com lag de perseguição simulado)
// ═══════════════════════════════════════════════════════════════════════════════

const WAYPOINTS = [
  { x: 0.05, y: 0.05 }, { x: 0.50, y: 0.05 }, { x: 0.95, y: 0.05 },
  { x: 0.95, y: 0.50 }, { x: 0.50, y: 0.50 }, { x: 0.05, y: 0.50 },
  { x: 0.05, y: 0.95 }, { x: 0.50, y: 0.95 }, { x: 0.95, y: 0.95 },
];

const FPS          = 30;
const DYN_MOVE_MS  = 1200;
const DYN_PULSE_MS = 1500;
const LAG_MS       = 200;  // lag típico de perseguição suave ocular

function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
}

interface DynamicSample {
  screenX: number; screenY: number;
  rawX: number;    rawY: number;
  weight: number;
}

function generateDynamicSamples(lagMs = LAG_MS): DynamicSample[] {
  const samples: DynamicSample[] = [];
  const frameMs = 1000 / FPS;

  for (let wi = 0; wi < WAYPOINTS.length; wi++) {
    const wp = WAYPOINTS[wi];

    // Fixação no waypoint atual (1500ms, peso 3)
    const pulseFrames = Math.round(DYN_PULSE_MS / frameMs);
    for (let f = 0; f < pulseFrames; f++) {
      // Olho está fixo no waypoint — sem lag de posição, só ruído de fixação
      samples.push({
        screenX: wp.x, screenY: wp.y,
        rawX: trueRawX(wp.x, wp.y) + randn() * FRAME_STD,
        rawY: trueRawY(wp.x, wp.y) + randn() * FRAME_STD,
        weight: 3.0,
      });
    }

    // Movimento para o próximo waypoint (1200ms, peso 1)
    if (wi + 1 < WAYPOINTS.length) {
      const next = WAYPOINTS[wi + 1];
      const moveFrames = Math.round(DYN_MOVE_MS / frameMs);

      for (let f = 0; f < moveFrames; f++) {
        const tBall = f / moveFrames;
        const tEye  = Math.max(0, (f * frameMs - lagMs) / DYN_MOVE_MS);

        const eBall = easeInOut(tBall);
        const eEye  = easeInOut(Math.min(tEye, 1));

        const ballX = wp.x + (next.x - wp.x) * eBall;
        const ballY = wp.y + (next.y - wp.y) * eBall;
        const eyeX  = wp.x + (next.x - wp.x) * eEye;
        const eyeY  = wp.y + (next.y - wp.y) * eEye;

        // O código grava (screenX=ball, rawX=eye) — viés sistemático quando ball ≠ eye
        samples.push({
          screenX: ballX, screenY: ballY,
          rawX: trueRawX(eyeX, eyeY) + randn() * FRAME_STD,
          rawY: trueRawY(eyeX, eyeY) + randn() * FRAME_STD,
          weight: 1.0,
        });
      }
    }
  }

  return samples;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 5. PONTOS DE VALIDAÇÃO (equivalente ao accuracy.ts)
//    5 pontos, cada um com 18 frames ruidosos (600ms × 30fps).
// ═══════════════════════════════════════════════════════════════════════════════

const VALIDATION_POINTS = [
  { name: "Centro",          sX: 0.50, sY: 0.50 },
  { name: "Canto Sup Esq",   sX: 0.03, sY: 0.03 },
  { name: "Canto Sup Dir",   sX: 0.97, sY: 0.03 },
  { name: "Canto Inf Esq",   sX: 0.03, sY: 0.97 },
  { name: "Canto Inf Dir",   sX: 0.97, sY: 0.97 },
];

const W  = 1920; // pixels de tela simulados
const H  = 1080;
const VAL_FRAMES = 18;

function evalError(
  mapFn: (rx: number, dy: number) => { x: number; y: number } | null
): { name: string; errPx: number }[] {
  return VALIDATION_POINTS.map(({ name, sX, sY }) => {
    let sumX = 0, sumY = 0, count = 0;
    for (let f = 0; f < VAL_FRAMES; f++) {
      const rx  = trueRawX(sX, sY) + randn() * FRAME_STD;
      const dy  = trueRawY(sX, sY) + randn() * FRAME_STD;
      const out = mapFn(rx, dy);
      if (out) { sumX += out.x; sumY += out.y; count++; }
    }
    if (count === 0) return { name, errPx: 9999 };
    const predX = sumX / count;
    const predY = sumY / count;
    const errPx = Math.sqrt((predX - sX * W) ** 2 + (predY - sY * H) ** 2);
    return { name, errPx };
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// 6. IMPLEMENTAÇÃO BILINEAR (extraída do HEAD — src/calibration.ts:532-590)
// ═══════════════════════════════════════════════════════════════════════════════

function makeBilinearMap(profile: CalibrationPoint[]) {
  if (profile.length !== 16) return null;

  const GRID_NORM = [0.0, 0.333, 0.667, 1.0];
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

  return (ratioX: number, dy: number): { x: number; y: number } | null => {
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

    return { x: clampVal(normX, 0, 1) * W, y: clampVal(normY, 0, 1) * H };
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 7. IMPLEMENTAÇÃO RIDGE (replicada de src/calibration.ts — versão nova)
// ═══════════════════════════════════════════════════════════════════════════════

const W_STATIC = 30;

function buildFeatures(r: number, d: number): number[] {
  return [1, r, d, r * r, r * d, d * d];
}

function solveLinear(A_in: number[][], b_in: number[]): number[] {
  const n = A_in.length;
  const A = A_in.map(row => [...row]);
  const b = [...b_in];
  for (let col = 0; col < n; col++) {
    let maxRow = col;
    for (let row = col + 1; row < n; row++)
      if (Math.abs(A[row][col]) > Math.abs(A[maxRow][col])) maxRow = row;
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

function fitRidgeWeighted(
  rs: number[], ds: number[],
  tgX: number[], tgY: number[],
  ws: number[], lambda: number
): { coefX: number[]; coefY: number[] } {
  const n = rs.length, nf = 6;
  const X = rs.map((r, i) => buildFeatures(r, ds[i]));
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

function loocvPixelError(
  rs: number[], ds: number[],
  tgX: number[], tgY: number[],
  ws: number[], lambda: number
): number {
  const n = rs.length, nf = 6;
  const X = rs.map((r, i) => buildFeatures(r, ds[i]));
  const XtWX = Array.from({ length: nf }, () => new Array(nf).fill(0));
  for (let i = 0; i < n; i++) {
    const w = ws[i];
    for (let j = 0; j < nf; j++)
      for (let k = 0; k < nf; k++) XtWX[j][k] += w * X[i][j] * X[i][k];
  }
  for (let j = 1; j < nf; j++) XtWX[j][j] += lambda;
  const inv = Array.from({ length: nf }, (_, c) => {
    const e = new Array(nf).fill(0); e[c] = 1;
    return solveLinear(XtWX.map(row => [...row]), e);
  });
  const { coefX, coefY } = fitRidgeWeighted(rs, ds, tgX, tgY, ws, lambda);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const xi = X[i], wi = ws[i];
    let hii = 0;
    for (let j = 0; j < nf; j++) {
      let axj = 0;
      for (let k = 0; k < nf; k++) axj += inv[k][j] * xi[k];
      hii += xi[j] * axj;
    }
    hii = Math.min(wi * hii, 0.9999);
    const predX = coefX.reduce((s, c, j) => s + c * xi[j], 0);
    const predY = coefY.reduce((s, c, j) => s + c * xi[j], 0);
    const cvX   = (tgX[i] - predX) / (1 - hii);
    const cvY   = (tgY[i] - predY) / (1 - hii);
    total += Math.sqrt((cvX * W) ** 2 + (cvY * H) ** 2);
  }
  return total / n;
}

function selectLambda(
  rs: number[], ds: number[], tgX: number[], tgY: number[]
): { lambda: number; table: [number, number][] } {
  const candidates = [0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1.0, 2.0];
  const ws = rs.map(() => 1);
  let best = Infinity, bestLambda = candidates[0];
  const table: [number, number][] = [];
  for (const lambda of candidates) {
    const err = loocvPixelError(rs, ds, tgX, tgY, ws, lambda);
    table.push([lambda, err]);
    if (err < best) { best = err; bestLambda = lambda; }
  }
  return { lambda: bestLambda, table };
}

function makeRidgeMap(
  profile: CalibrationPoint[],
  dynSamples: DynamicSample[] = []
): (rx: number, dy: number) => { x: number; y: number } | null {
  const rs:  number[] = [], ds:  number[] = [];
  const tgX: number[] = [], tgY: number[] = [];
  const ws:  number[] = [];
  for (const p of profile) {
    rs.push(p.rawX); ds.push(p.rawY);
    tgX.push(p.screenX); tgY.push(p.screenY);
    ws.push(W_STATIC);
  }
  for (const s of dynSamples) {
    rs.push(s.rawX); ds.push(s.rawY);
    tgX.push(s.screenX); tgY.push(s.screenY);
    ws.push(s.weight);
  }

  const staticRs  = profile.map(p => p.rawX);
  const staticDs  = profile.map(p => p.rawY);
  const { lambda } = selectLambda(staticRs, staticDs,
                                   profile.map(p => p.screenX),
                                   profile.map(p => p.screenY));

  const { coefX, coefY } = fitRidgeWeighted(rs, ds, tgX, tgY, ws, lambda);

  return (ratioX, dy) => {
    const f    = buildFeatures(ratioX, dy);
    const normX = Math.min(Math.max(coefX.reduce((s, c, i) => s + c * f[i], 0), 0), 1);
    const normY = Math.min(Math.max(coefY.reduce((s, c, i) => s + c * f[i], 0), 0), 1);
    return { x: normX * W, y: normY * H };
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 8. ANÁLISE DE VIÉS DE LAG DE PERSEGUIÇÃO
//    Quantifica o erro introduzido pelos samples de transição em função do lag.
// ═══════════════════════════════════════════════════════════════════════════════

function pursuitLagBiasAnalysis(profile: CalibrationPoint[]) {
  console.log("\n══════════════════════════════════════════════════════════");
  console.log("ANÁLISE DE VIÉS DE LAG DE PERSEGUIÇÃO OCULAR");
  console.log("══════════════════════════════════════════════════════════");

  // Baseline: ridge sem nenhum sample dinâmico
  _seed = 999;
  const ridgeOnlyFn = makeRidgeMap(profile, []);
  const errBase   = evalError(ridgeOnlyFn);
  const meanBase  = errBase.reduce((s, e) => s + e.errPx, 0) / errBase.length;

  const lagValues = [0, 100, 150, 200, 250, 300];

  console.log(`\nBaseline: Ridge (16 pts, sem dinâmicos) = ${meanBase.toFixed(1)}px`);
  console.log("\nErro médio de validação (px) por lag de perseguição:");
  console.log("Lag (ms)  | Dyn lag=0 (ideal) | Dyn lag=N  | Δ lag vs ideal | Δ vs sem-dyn");
  console.log("----------+-------------------+------------+----------------+-------------");

  // Gera uma vez lag=0 para referência estável
  _seed = 42;
  const dynLag0 = generateDynamicSamples(0);
  _seed = 999;
  const mapLag0  = makeRidgeMap(profile, dynLag0);
  const errLag0  = evalError(mapLag0);
  const meanLag0 = errLag0.reduce((s, e) => s + e.errPx, 0) / errLag0.length;

  for (const lag of lagValues) {
    _seed = 42 + lag; // seed diferente por lag para evitar correlação
    const dynWithLag   = generateDynamicSamples(lag);

    _seed = 999;
    const mapWithLag  = makeRidgeMap(profile, dynWithLag);
    const errWithLag  = evalError(mapWithLag);
    const meanWithLag = errWithLag.reduce((s, e) => s + e.errPx, 0) / errWithLag.length;

    const deltaIdeal  = meanWithLag - meanLag0;
    const deltaBase   = meanWithLag - meanBase;
    const lagStr      = String(lag).padStart(5);
    const lag0Str     = meanLag0.toFixed(1).padStart(8);
    const wLagStr     = meanWithLag.toFixed(1).padStart(8);
    const dIdealStr   = (deltaIdeal >= 0 ? "+" : "") + deltaIdeal.toFixed(1);
    const dBaseStr    = (deltaBase  >= 0 ? "+" : "") + deltaBase.toFixed(1);
    console.log(`${lagStr}ms    | ${lag0Str}px           | ${wLagStr}px   | ${dIdealStr.padStart(8)}px      | ${dBaseStr.padStart(6)}px`);
  }

  // Analisa o viés direcional (X e Y separadamente) com lag=200ms
  console.log("\nViés direcional para lag=200ms (deslocamento médio previsto vs real):");
  _seed = 42;
  const dynLag200  = generateDynamicSamples(200);
  const movSamples = dynLag200.filter(s => s.weight === 1.0);
  const fixSamples = dynLag200.filter(s => s.weight === 3.0);

  // Para cada sample de movimento, calcula o offset screen_recorded - screen_true_from_eye
  let biasX = 0, biasY = 0;
  for (const s of movSamples) {
    // Aqui rawX = trueRawX(eyeX, eyeY), mas screenX = ballX
    // O viés é: screenX_recorded - screenX_that_matches_rawX
    // Dado que trueRawX é inversível, aproximamos pelo erro de predição
    biasX += s.screenX - trueInverseX(s.rawX, s.rawY);
    biasY += s.screenY - trueInverseY(s.rawX, s.rawY);
  }
  biasX /= movSamples.length;
  biasY /= movSamples.length;

  console.log(`  Samples de fixação: ${fixSamples.length} | Samples de movimento: ${movSamples.length}`);
  console.log(`  Viés X médio nos samples de movimento: ${(biasX * W).toFixed(1)}px (${biasX > 0 ? "→ direita" : "← esquerda"})`);
  console.log(`  Viés Y médio nos samples de movimento: ${(biasY * H).toFixed(1)}px (${biasY > 0 ? "↓ baixo" : "↑ cima"})`);

  // Verifica cancelamento: snake path deveria cancelar X mas não Y
  let rightwardBias = 0, leftwardBias = 0, downwardBias = 0;
  for (let wi = 0; wi + 1 < WAYPOINTS.length; wi++) {
    const A = WAYPOINTS[wi], B = WAYPOINTS[wi + 1];
    const dx = B.x - A.x, dy = B.y - A.y;
    // Direção predominante
    if (Math.abs(dx) > Math.abs(dy)) {
      if (dx > 0) rightwardBias++; else leftwardBias++;
    } else {
      if (dy > 0) downwardBias++;
    }
  }
  console.log(`\n  Segmentos direcionais no snake path:`);
  console.log(`    Rightward (+X): ${rightwardBias}  |  Leftward (-X): ${leftwardBias}  |  Downward (+Y): ${downwardBias}  |  Upward (-Y): 0`);
  console.log(`  → Viés X parcialmente cancelado (${rightwardBias} vs ${leftwardBias}), mas residual de ${rightwardBias - leftwardBias} segmento(s)`);
  console.log(`  → Viés Y NÃO cancelado — todos os ${downwardBias} segmentos Y vão para baixo`);
}

// Inverte o modelo verdadeiro numericamente (Newton com 5 iterações — suficiente para precisão <1px)
function trueInverseX(rawX: number, rawY: number): number {
  let sX = 0.5, sY = rawY / 0.12 + 0.5; // chute inicial
  for (let i = 0; i < 10; i++) {
    sX -= (trueRawX(sX, sY) - rawX) / (-0.30 + 0.05 * (sX - 0.5));
    sX  = Math.min(Math.max(sX, 0), 1);
  }
  return sX;
}
function trueInverseY(rawX: number, rawY: number): number {
  let sY = (rawY + 0.05) / 0.12;
  for (let i = 0; i < 10; i++) {
    sY -= (trueRawY(0.5, sY) - rawY) / (0.12 + 0.036 * (sY - 0.5));
    sY  = Math.min(Math.max(sY, 0), 1);
  }
  return sY;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 9. RUNNER PRINCIPAL
// ═══════════════════════════════════════════════════════════════════════════════

function run() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("IrisFlow — Comparação de Modelos: Bilinear vs Ridge Regression");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`Tela: ${W}×${H}px | Grid: 4×4 | Ruído/frame: std=${FRAME_STD} | N_avg=${N_AVG}`);
  console.log(`Lag de perseguição simulado: ${LAG_MS}ms | FPS: ${FPS}`);

  // Gera dados uma vez — mesmos dados para bilinear e ridge
  _seed = 42;
  const profile   = generateStaticProfile();
  const dynSamples = generateDynamicSamples(LAG_MS);

  console.log(`\nPerfil estático: ${profile.length} pontos | Amostras dinâmicas: ${dynSamples.length}`);
  const nFix = dynSamples.filter(s => s.weight === 3).length;
  const nMov = dynSamples.filter(s => s.weight === 1).length;
  console.log(`  Fixação (w=3): ${nFix} | Movimento (w=1): ${nMov}`);

  // ── LOOCV nos 16 pontos estáticos ──────────────────────────────────────────
  console.log("\n── LOOCV nos 16 pontos estáticos (generalização do modelo) ────");
  const ws1 = profile.map(() => 1);
  const rs   = profile.map(p => p.rawX);
  const ds   = profile.map(p => p.rawY);
  const tgX  = profile.map(p => p.screenX);
  const tgY  = profile.map(p => p.screenY);

  const { lambda, table } = selectLambda(rs, ds, tgX, tgY);
  const loocvRidge = loocvPixelError(rs, ds, tgX, tgY, ws1, lambda);
  const loocvOLS   = loocvPixelError(rs, ds, tgX, tgY, ws1, 0.0001);

  console.log(`  OLS   (λ→0)   LOOCV médio: ${loocvOLS.toFixed(1)}px`);
  console.log(`  Ridge (λ=${lambda}) LOOCV médio: ${loocvRidge.toFixed(1)}px`);
  console.log(`  Ganho: ${(loocvOLS - loocvRidge).toFixed(1)}px (${(100 * (loocvOLS - loocvRidge) / loocvOLS).toFixed(0)}% de redução)`);

  // ── Validação nos 5 pontos (equivalente ao accuracy.ts) ───────────────────
  console.log("\n── Erro de validação nos 5 pontos (accuracy.ts equivalente) ───");

  // Cenário 1: só estáticos
  _seed = 999;
  const bilinearMap  = makeBilinearMap(profile)!;
  const ridgeOnlyMap = makeRidgeMap(profile, []);

  // Cenário 2: estáticos + fixação-apenas (w=0.5) com lag=200ms — configuração final aplicada
  const fixationOnly = dynSamples
    .filter(s => s.weight > 1.5)
    .map(s => ({ ...s, weight: 0.5 }));
  const ridgeFullMap = makeRidgeMap(profile, fixationOnly);

  _seed = 999;
  const errBilinear  = evalError(bilinearMap);
  _seed = 999;
  const errRidgeOnly = evalError(ridgeOnlyMap);
  _seed = 999;
  const errRidgeFull = evalError(ridgeFullMap);

  console.log("\n" + "Ponto".padEnd(20) + "Bilinear".padStart(12) + "Ridge (16 pts)".padStart(16) + "Ridge+Fix(w=0.5)".padStart(18));
  console.log("─".repeat(60));
  for (let i = 0; i < VALIDATION_POINTS.length; i++) {
    const name = VALIDATION_POINTS[i].name.padEnd(20);
    const b    = (errBilinear[i].errPx.toFixed(1) + "px").padStart(12);
    const r    = (errRidgeOnly[i].errPx.toFixed(1) + "px").padStart(16);
    const rd   = (errRidgeFull[i].errPx.toFixed(1) + "px").padStart(12);
    console.log(name + b + r + rd);
  }
  console.log("─".repeat(60));

  const meanB   = errBilinear.reduce((s, e)  => s + e.errPx, 0) / errBilinear.length;
  const maxB    = Math.max(...errBilinear.map(e => e.errPx));
  const meanRO  = errRidgeOnly.reduce((s, e) => s + e.errPx, 0) / errRidgeOnly.length;
  const maxRO   = Math.max(...errRidgeOnly.map(e => e.errPx));
  const meanRF  = errRidgeFull.reduce((s, e) => s + e.errPx, 0) / errRidgeFull.length;
  const maxRF   = Math.max(...errRidgeFull.map(e => e.errPx));

  console.log("Média".padEnd(20) + (meanB.toFixed(1) + "px").padStart(12) + (meanRO.toFixed(1) + "px").padStart(16) + (meanRF.toFixed(1) + "px").padStart(12));
  console.log("Máximo".padEnd(20) + (maxB.toFixed(1)  + "px").padStart(12) + (maxRO.toFixed(1) + "px").padStart(16) + (maxRF.toFixed(1)  + "px").padStart(12));

  const W_diag = Math.sqrt(W * W + H * H);
  console.log("\nScores (accuracy.ts: <30px=Excelente, <60px=Bom, <100px=Regular):");
  const score = (mean: number) => mean < 30 ? "EXCELENTE" : mean < 60 ? "BOM" : mean < 100 ? "REGULAR" : "RUIM";
  console.log(`  Bilinear           : ${score(meanB).padEnd(10)} (${meanB.toFixed(1)}px médio, ${(100*meanB/W_diag).toFixed(2)}% diagonal)`);
  console.log(`  Ridge 16pts        : ${score(meanRO).padEnd(10)} (${meanRO.toFixed(1)}px médio, ${(100*meanRO/W_diag).toFixed(2)}% diagonal)`);
  console.log(`  Ridge+Fix(w=0.5)   : ${score(meanRF).padEnd(10)} (${meanRF.toFixed(1)}px médio, ${(100*meanRF/W_diag).toFixed(2)}% diagonal)  ← configuração final`);

  // ── Contribuição das sub-categorias dinâmicas ─────────────────────────────
  console.log("\n── Contribuição das sub-categorias (lag=200ms, mesmo perfil) ──");
  console.log("  Variações testadas do uso dos samples dinâmicos:");

  const fixOnly   = dynSamples.filter(s => s.weight === 3.0);
  const movOnly   = dynSamples.filter(s => s.weight === 1.0);
  const fixWeakened = fixOnly.map(s => ({ ...s, weight: 0.5 }));

  type ScenarioMap = (rx: number, dy: number) => { x: number; y: number } | null;
  const scenarios: [string, ScenarioMap][] = [
    ["Só estáticos",                makeRidgeMap(profile, [])],
    ["+ Fix (w=3.0)",               makeRidgeMap(profile, fixOnly)],
    ["+ Fix (w=0.5)",               makeRidgeMap(profile, fixWeakened)],
    ["+ Fix (w=3) + Mov (w=1.0)",   makeRidgeMap(profile, dynSamples)],
    ["+ Fix (w=3) + Mov (w=0.2)",   makeRidgeMap(profile, [...fixOnly, ...movOnly.map(s => ({...s, weight: 0.2}))])],
    ["+ Fix (w=3) + Mov (w=0.0)",   makeRidgeMap(profile, fixOnly)],  // exclui mov
  ];
  for (const [label, mapFn] of scenarios) {
    _seed = 999;
    const errs = evalError(mapFn);
    const mean = errs.reduce((s, e) => s + e.errPx, 0) / errs.length;
    const max  = Math.max(...errs.map(e => e.errPx));
    const sc   = mean < 30 ? "EXCELENTE" : mean < 60 ? "BOM" : mean < 100 ? "REGULAR" : "RUIM";
    console.log(`  ${label.padEnd(32)}: ${(mean.toFixed(1) + "px").padStart(8)} médio, ${(max.toFixed(1) + "px").padStart(8)} máx  [${sc}]`);
  }

  // ── Estabilidade (ruído frame-a-frame no cursor) ───────────────────────────
  console.log("\n── Instabilidade frame-a-frame (jitter no cursor) ─────────────");
  console.log("  Mede quanto o cursor salta entre frames consecutivos no ponto central.");
  const jitterFrames = 50;
  let jB = 0, jRO = 0, jRF = 0;
  let prevB  = bilinearMap(trueRawX(0.5, 0.5),  trueRawY(0.5, 0.5))!;
  let prevRO = ridgeOnlyMap(trueRawX(0.5, 0.5), trueRawY(0.5, 0.5))!;
  let prevRF = ridgeFullMap(trueRawX(0.5, 0.5), trueRawY(0.5, 0.5))!;
  for (let f = 0; f < jitterFrames; f++) {
    const rx = trueRawX(0.5, 0.5) + randn() * FRAME_STD;
    const dy = trueRawY(0.5, 0.5) + randn() * FRAME_STD;
    const bN  = bilinearMap(rx, dy)!;
    const rON = ridgeOnlyMap(rx, dy)!;
    const rFN = ridgeFullMap(rx, dy)!;
    jB  += Math.sqrt((bN.x  - prevB.x)  ** 2 + (bN.y  - prevB.y)  ** 2);
    jRO += Math.sqrt((rON.x - prevRO.x) ** 2 + (rON.y - prevRO.y) ** 2);
    jRF += Math.sqrt((rFN.x - prevRF.x) ** 2 + (rFN.y - prevRF.y) ** 2);
    prevB = bN; prevRO = rON; prevRF = rFN;
  }
  console.log(`  Bilinear    : ${(jB  / jitterFrames).toFixed(1)}px/frame médio`);
  console.log(`  Ridge 16pts : ${(jRO / jitterFrames).toFixed(1)}px/frame médio`);
  console.log(`  Ridge+Fix(w=0.5): ${(jRF / jitterFrames).toFixed(1)}px/frame médio`);
  console.log("  Nota: jitter a este nível é antes do rolling buffer e do lerp 0.05.");

  // ── Monte Carlo: robustez a variações de calibração ───────────────────────
  console.log("\n── Robustez Monte Carlo (N=100 calibrações independentes) ──────");
  const N_MC = 100;
  const mcB:  number[] = [], mcRO: number[] = [], mcRF: number[] = [];
  for (let mc = 0; mc < N_MC; mc++) {
    _seed = mc * 7919 + 13;
    const prof  = generateStaticProfile();
    const dyn   = generateDynamicSamples(LAG_MS);
    const bmFn  = makeBilinearMap(prof)!;
    const roFn  = makeRidgeMap(prof, []);
    const rfFn  = makeRidgeMap(prof, dyn);
    _seed = mc * 3571 + 77;
    const eB  = evalError(bmFn);
    const eRO = evalError(roFn);
    const eRF = evalError(rfFn);
    mcB.push( eB.reduce( (s, e) => s + e.errPx, 0) / eB.length);
    mcRO.push(eRO.reduce((s, e) => s + e.errPx, 0) / eRO.length);
    mcRF.push(eRF.reduce((s, e) => s + e.errPx, 0) / eRF.length);
  }
  const p = (arr: number[], q: number) => {
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(q * s.length)];
  };
  console.log("           " + "P25".padStart(8) + "Mediana".padStart(10) + "Média".padStart(8) + "P75".padStart(8) + "P95".padStart(8));
  const row = (label: string, arr: number[]) => {
    const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
    console.log(
      label.padEnd(14) +
      (p(arr,0.25).toFixed(1)+"px").padStart(8) +
      (p(arr,0.50).toFixed(1)+"px").padStart(10) +
      (mean.toFixed(1)+"px").padStart(8) +
      (p(arr,0.75).toFixed(1)+"px").padStart(8) +
      (p(arr,0.95).toFixed(1)+"px").padStart(8)
    );
  };
  row("Bilinear", mcB);
  row("Ridge 16pts", mcRO);
  row("Ridge+Fix(0.5)", mcRF);

  // ── Análise de lag de perseguição ─────────────────────────────────────────
  pursuitLagBiasAnalysis(profile);

  // ── Recomendações ──────────────────────────────────────────────────────────
  console.log("\n══════════════════════════════════════════════════════════");
  console.log("RECOMENDAÇÕES");
  console.log("══════════════════════════════════════════════════════════");

  const ridgeGain    = ((meanB  - meanRO) / meanB)  * 100;
  const dynGain      = ((meanRO - meanRF) / meanRO) * 100;
  const dynHurts     = meanRF  > meanRO;

  console.log(`\nGanho ridge vs bilinear (só estáticos): ${ridgeGain.toFixed(0)}% de redução`);
  console.log(`Efeito amostras dinâmicas (lag=${LAG_MS}ms): ${dynHurts ? "PIORA " + Math.abs(dynGain).toFixed(0) + "%" : "MELHORA " + dynGain.toFixed(0) + "%"}`);

  if (dynHurts) {
    const downgrade = meanRF - meanRO;
    console.log(`\n⚠  Os samples de MOVIMENTO (w=1.0) com lag=${LAG_MS}ms introduzem +${downgrade.toFixed(1)}px de viés.`);
    console.log("   O snake path NÃO cancela o viés em Y (todos os segmentos Y são descendentes).");
    console.log("   Opções para corrigir (em ordem de impacto/custo):");
    console.log("   1. Reduzir peso de movimento: w=0.0 (excluir) ou w=0.2 (mínima influência)");
    console.log("   2. Gating temporal: descartar os primeiros 200ms de cada segmento de movimento");
    console.log("   3. Gating espacial: só incluir sample se dist(ball, nearest_waypoint) < 0.20");
  } else {
    console.log("\n✓ Os samples dinâmicos melhoram o modelo mesmo com lag de perseguição.");
    console.log("  O peso w=1.0 para movimento é adequado para este nível de lag.");
  }
}

run();
