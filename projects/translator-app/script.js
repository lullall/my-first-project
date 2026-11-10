// 元素引用
const inputText = document.getElementById("inputText");
const outputText = document.getElementById("outputText");
const engineHint = document.getElementById("engineHint");
const charCount = document.getElementById("charCount");
const translateBtn = document.getElementById("translateBtn");
const pauseBtn = document.getElementById("pauseBtn");
const abortBtn = document.getElementById("abortBtn");
const sourceLang = document.getElementById("sourceLang");
const targetLang = document.getElementById("targetLang");
const proxyInput = document.getElementById("proxyInput");

// 单段最大字符数（MyMemory 匿名上限约 500，预留余量）
const MAX_SEGMENT = 450;
// 每段最大重试次数（1 次 + 2 次重试）
const MAX_ATTEMPTS = 3;
// 重试前的等待时间（毫秒）
const RETRY_DELAY = 500;
// 每段翻译之间的强制间隔（毫秒），避免触发频率限制
const SEGMENT_GAP = 1000;
// Google 接口超时（毫秒），超时即静默回退 MyMemory
const GOOGLE_TIMEOUT = 8000;
// CORS 代理：用于绕过 Google 接口的跨域限制（访问前需先在浏览器打开一次该地址授权）
const CORS_PROXY = "https://cors-anywhere.herokuapp.com/";

// ===== 全局翻译状态 =====
let isPaused = false; // 是否暂停
let isAborted = false; // 是否强制中止
let currentIndex = 0; // 当前翻译到第几段（从 0 开始）
let segments = []; // 分段后的文本
let results = []; // 各段翻译结果（与 segments 一一对应）
let engineOf = []; // 各段实际使用的引擎（"Google" / "MyMemory" / null）
let googleLang = null; // Google 语言对 { sl, tl }
let mymemoryLang = null; // MyMemory 语言对 { sl, tl }
let hasFailure = false; // 是否有段落翻译失败
let translating = false; // 是否处于翻译任务中
let abortController = null; // 用于取消在途请求
let resumeFn = null; // 暂停时挂起的 resolve，用于唤醒循环
let corsProxy = CORS_PROXY; // 当前生效的 CORS 代理前缀（界面可配置）

// 语言代码映射
// Google：支持 auto 自动检测；中文 zh-CN、英文 en、日文 ja
const GOOGLE_MAP = { zh: "zh-CN", en: "en", ja: "ja" };
// MyMemory：ISO 标准；自动检测统一发 en（autodetect 不稳定）
const MYMEMORY_MAP = { zh: "zh-CN", en: "en", ja: "ja" };

// 更新字数统计
function updateCharCount() {
  const len = inputText.value.trim().length;
  charCount.textContent = `${len} 字`;
}

// 短暂等待
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 合并“用户中止信号”与“超时信号”：任一触发即 abort
function combineSignal(parentSignal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const clear = () => clearTimeout(timer);
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort();
    else parentSignal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  controller.signal.addEventListener("abort", clear, { once: true });
  return controller.signal;
}

// 规范化代理地址：确保以 “/” 结尾；为空则返回空串（直连，不走代理）
function normalizeProxy(raw) {
  const v = (raw || "").trim();
  if (!v) return "";
  return v.endsWith("/") ? v : v + "/";
}

// 暂停时阻塞循环，直到被“继续”或“中止”唤醒
function waitWhilePaused() {
  return new Promise((resolve) => {
    resumeFn = resolve;
  });
}

// 已翻译完成部分的拼接（用于暂停时保留进度展示）
function mergedSoFar() {
  return results.slice(0, currentIndex).join("");
}

// 按句子/换行切分，保留句末标点与换行符（避免破坏原始结构）
function splitIntoSentences(text) {
  const result = [];
  let current = "";
  const delimiters = ["。", "！", "？", "!", "?", ".", "\n"];
  for (const ch of text) {
    current += ch;
    if (delimiters.includes(ch)) {
      result.push(current);
      current = "";
    }
  }
  if (current) result.push(current);
  return result;
}

// 超长且无标点的段落：强制切分，尽量在空格处断开，避免切断英文单词
function forceSplit(text, limit) {
  const pieces = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + limit, text.length);
    if (end < text.length) {
      // 从 limit 位置向前回溯最多 40 个字符，寻找一个空格作为断点
      let cut = end;
      for (let i = end; i > start + limit - 40 && i > start; i--) {
        if (text[i] === " " || text[i] === "\n") {
          cut = i + 1; // 把空格归入前一段
          break;
        }
      }
      end = cut;
    }
    pieces.push(text.slice(start, end));
    start = end;
  }
  return pieces;
}

// 智能切分：超过上限先按标点/换行切，超长无标点段落再强制切
function smartSplit(text, limit) {
  if (text.length <= limit) return [text];

  const sentences = splitIntoSentences(text);
  const chunks = [];
  let current = "";

  for (const s of sentences) {
    if (current.length + s.length > limit) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      if (s.length > limit) {
        for (const piece of forceSplit(s, limit)) chunks.push(piece);
      } else {
        current = s;
      }
    } else {
      current += s;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// ===== 引擎 1：Google 翻译（首选，无需密钥）=====
async function translateViaGoogle(text, lang, parentSignal) {
  const url =
    corsProxy +
    "https://translate.googleapis.com/translate_a/single" +
    `?client=gtx&sl=${encodeURIComponent(lang.sl)}&tl=${encodeURIComponent(lang.tl)}` +
    `&dt=t&q=${encodeURIComponent(text)}`;

  const signal = combineSignal(parentSignal, GOOGLE_TIMEOUT);
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    // 返回结构：data[0] 是若干 [译文片段, 原文片段, ...] 的数组
    let translated = "";
    if (Array.isArray(data) && Array.isArray(data[0])) {
      for (const seg of data[0]) {
        if (seg && typeof seg[0] === "string") translated += seg[0];
      }
    }
    if (!translated) throw new Error("Google 返回结果为空");
    return translated;
  } catch (err) {
    console.error("Google 翻译请求失败：", err && err.message);
    throw err; // 交给上层静默回退 MyMemory
  }
}

// ===== 引擎 2：MyMemory（兜底）=====
async function translateViaMyMemory(text, lang, parentSignal) {
  const url =
    "https://api.mymemory.translated.net/get" +
    `?q=${encodeURIComponent(text)}` +
    `&langpair=${encodeURIComponent(lang.sl + "|" + lang.tl)}`;

  try {
    const res = await fetch(url, { signal: parentSignal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    // 额度用尽（quotaFinished 为 true，或 429 超限）
    if (data.quotaFinished === true || data.responseStatus === 429) {
      throw new Error("API返回：额度已用尽（每日免费翻译额度已超限，约 24 小时后重置）");
    }
    // 非 200 视为错误
    if (data.responseStatus !== 200) {
      throw new Error(`API错误：${data.responseStatus}（${data.responseDetails || "未知错误"}）`);
    }
    // 校验返回结构
    if (!data.responseData || typeof data.responseData.translatedText !== "string") {
      throw new Error("API错误：返回结构异常，缺少 translatedText");
    }
    return data.responseData.translatedText;
  } catch (err) {
    console.error("MyMemory 翻译请求失败：", err && err.message);
    throw err;
  }
}

// 双引擎翻译：首选 Google，失败则静默回退 MyMemory
async function translateSegmentDual(text, googleLang, mymemoryLang, signal) {
  // 1) 首选 Google
  try {
    const t = await translateViaGoogle(text, googleLang, signal);
    return { text: t, engine: "Google" };
  } catch (e) {
    console.error("Google 翻译失败，静默回退到 MyMemory：", e && e.message);
  }
  // 2) 兜底 MyMemory
  try {
    const t = await translateViaMyMemory(text, mymemoryLang, signal);
    return { text: t, engine: "MyMemory" };
  } catch (e) {
    console.error("MyMemory 兜底翻译也失败：", e && e.message);
    throw e; // 两个引擎都失败，向上抛出触发重试
  }
}

// 恢复初始按钮状态（只显示“翻译”）
function restoreButtons() {
  translateBtn.hidden = false;
  translateBtn.disabled = false;
  translateBtn.textContent = "翻译";
  pauseBtn.hidden = true;
  pauseBtn.disabled = false;
  pauseBtn.textContent = "暂停";
  abortBtn.hidden = true;
  abortBtn.disabled = false;
}

// 重置全部翻译任务状态
function resetState() {
  isPaused = false;
  isAborted = false;
  currentIndex = 0;
  segments = [];
  results = [];
  engineOf = [];
  googleLang = null;
  mymemoryLang = null;
  hasFailure = false;
  abortController = null;
  resumeFn = null;
  engineHint.textContent = "";
}

// 开始翻译：隐藏“翻译”，显示“暂停/继续”与“强制中止”
function startTranslation() {
  const text = inputText.value.trim();
  if (!text) {
    outputText.textContent = "请先输入要翻译的内容…";
    return;
  }

  const src = sourceLang.value; // auto / zh / en / ja
  const tgt = targetLang.value; // zh / en / ja

  // Google 语言对（支持 auto 自动检测）
  googleLang = {
    sl: src === "auto" ? "auto" : GOOGLE_MAP[src],
    tl: GOOGLE_MAP[tgt],
  };
  // MyMemory 语言对（自动检测统一发 en，规避 autodetect 不稳定）
  mymemoryLang = {
    sl: src === "auto" ? "en" : MYMEMORY_MAP[src],
    tl: MYMEMORY_MAP[tgt],
  };

  // 读取界面配置的 CORS 代理（开始翻译时定格，翻译过程中修改不生效）
  corsProxy = normalizeProxy(proxyInput.value);

  segments = smartSplit(text, MAX_SEGMENT).filter((s) => s.trim().length > 0);
  results = new Array(segments.length);
  engineOf = new Array(segments.length);
  currentIndex = 0;
  isPaused = false;
  isAborted = false;
  hasFailure = false;
  translating = true;
  engineHint.textContent = "";

  // 切换按钮可见性
  translateBtn.hidden = true;
  pauseBtn.hidden = false;
  abortBtn.hidden = false;
  pauseBtn.textContent = "暂停";

  runLoop();
}

// 主循环：从 currentIndex 串行翻译，支持暂停/继续/中止
async function runLoop() {
  while (currentIndex < segments.length) {
    if (isAborted) break;

    // 暂停分支：等当前在途请求完成后，在此处挂起
    if (isPaused) {
      const partial = mergedSoFar();
      outputText.textContent = (partial ? partial + "\n\n" : "") + "已暂停";
      await waitWhilePaused();
      if (isAborted) break;
      continue; // 唤醒后重新检查状态
    }

    const i = currentIndex;
    const progressText = `正在翻译第 ${i + 1} / ${segments.length} 段...`;
    pauseBtn.textContent = "暂停";
    outputText.textContent = progressText;

    abortController = new AbortController();
    let translated = null;
    let lastErr = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const r = await translateSegmentDual(
          segments[i],
          googleLang,
          mymemoryLang,
          abortController.signal
        );
        translated = r.text;
        engineOf[i] = r.engine;
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (isAborted) break; // 中止时不再重试
        if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY);
      }
    }

    if (isAborted) break; // 在途请求被取消，退出循环

    if (translated !== null) {
      results[i] = translated;
    } else {
      // 记录具体错误信息（额度用尽 / API 错误码），而不是简单地“保留原文”
      hasFailure = true;
      results[i] = `【${lastErr ? lastErr.message : "翻译失败"}】`;
    }
    currentIndex++;

    // 每段翻译之间强制间隔 1 秒，避免触发频率限制
    if (currentIndex < segments.length) {
      await new Promise((r) => setTimeout(r, SEGMENT_GAP));
    }
  }

  if (isAborted) {
    // 强制中止：清空右侧、重置状态、恢复初始按钮
    translating = false;
    outputText.textContent = "翻译结果将显示在这里…";
    resetState();
    restoreButtons();
  } else {
    // 正常完成
    finishTranslation();
  }
}

// 正常完成：合并结果、标记引擎、展示
function finishTranslation() {
  translating = false;
  const merged = results.join("");

  // 引擎提示小字：汇总本次实际使用的引擎
  const engines = [...new Set(engineOf.filter(Boolean))];
  if (engines.length === 1) {
    engineHint.textContent = `本次翻译由 ${engines[0]} 提供`;
  } else if (engines.length > 1) {
    engineHint.textContent = `本次翻译由 ${engines.join(" / ")} 提供`;
  } else {
    engineHint.textContent = "";
  }

  if (hasFailure) {
    outputText.textContent =
      merged + "\n\n⚠ 部分段落翻译出错，详情见上方各段标记。";
  } else {
    outputText.textContent = merged;
  }
  restoreButtons();
}

// 暂停 / 继续
pauseBtn.addEventListener("click", () => {
  if (!translating) return;
  if (!isPaused) {
    // 暂停：正在请求的那一段会自然完成，循环在下一轮前挂起
    isPaused = true;
    pauseBtn.textContent = "继续";
  } else {
    // 继续：解除暂停，从 currentIndex 接着翻译
    isPaused = false;
    pauseBtn.textContent = "暂停";
    if (resumeFn) {
      const r = resumeFn;
      resumeFn = null;
      r();
    }
  }
});

// 强制中止（红色按钮）
abortBtn.addEventListener("click", () => {
  if (!translating) return;
  isAborted = true;
  if (abortController) abortController.abort(); // 立即取消在途请求
  if (resumeFn) {
    // 若处于暂停等待中，唤醒循环使其退出
    const r = resumeFn;
    resumeFn = null;
    r();
  }
});

// 事件绑定
inputText.addEventListener("input", updateCharCount);
translateBtn.addEventListener("click", startTranslation);

// CORS 代理：从 localStorage 恢复上次的配置，并实时保存
(function initProxy() {
  const saved = (function () {
    try {
      return localStorage.getItem("corsProxy");
    } catch (e) {
      return null;
    }
  })();
  if (saved !== null) proxyInput.value = saved;
  proxyInput.addEventListener("input", function () {
    try {
      localStorage.setItem("corsProxy", proxyInput.value);
    } catch (e) {
      /* localStorage 不可用时忽略 */
    }
  });
})();

// 初始状态
updateCharCount();
