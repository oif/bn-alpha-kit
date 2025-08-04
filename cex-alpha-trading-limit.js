/*
 * cex-alpha-trading-limit.js
 *
 * 用途：
 *   用于中心化交易所（CEX）网页端自动化刷交易量，支持自动买入、卖出、订单状态检测、弹窗处理等。
 *   适用于币安等采用类似 DOM 结构的交易页面。
 *
 * 使用说明:
 *   1. 打开浏览器，进入目标交易对页面 (例如: https://www.binance.com/zh-CN/alpha/bsc/0x92aa03137385f18539301349dcfc9ebc923ffb10)
 *   2. 打开开发者工具 (F12)，进入控制台 tab
 *   3. 配置以下参数:
 *      - ORDER_PRICE_BUY: 买入价格（固定价格模式）
 *      - ORDER_PRICE_SELL: 卖出价格（固定价格模式）
 *      - ENABLE_DYNAMIC_PRICING: 是否启用动态价格设定（true/false）
 *      - PRICE_OFFSET: 动态价格偏移量（建议 0.000001）
 *      - ORDER_VOLUME: 每次买/卖的数量
 *      - MAX_TRADES: 交易循环次数
 *      - ORDER_TIMEOUT_MS: 单笔订单最大等待成交时间（毫秒）
 *      - ABORT_ON_PRICE_WARNING: 遇到价格警告弹窗时是否中止（true/false）
 *   4. 复制修改后的代码到控制台中并运行
 *
 * 主要参数说明：
 *   ORDER_PRICE_BUY         —— 买入价格（固定价格模式）
 *   ORDER_PRICE_SELL        —— 卖出价格（固定价格模式）
 *   ENABLE_DYNAMIC_PRICING  —— 是否启用动态价格设定（true/false）
 *   PRICE_OFFSET            —— 动态价格偏移量（买入价格 = 分布最多价格 + 偏移量，卖出价格 = 分布最多价格 - 偏移量）
 *   定价可以放在 K 线核心波动范围内，必要时候可以考虑卖出高于买入，价格建议参考手机客户端限价交易页面的实时成交记录设定。
 *   启用动态价格时，每轮交易前会自动从成交记录中分析价格分布，找到出现次数最多的价格作为基准，实现最小磨损。
 *   ORDER_VOLUME            —— 每次买/卖的数量
 *   MAX_TRADES              —— 最大刷单轮数
 *   ORDER_TIMEOUT_MS        —— 单笔订单最大等待成交时间（毫秒），如果是希望低磨损，慢慢等待合适价格买卖的话，推荐这个值给到分钟级以上
 *   ABORT_ON_PRICE_WARNING  —— 遇到价格警告弹窗时是否中止（true/false）
 *
 * 注意事项：
 *   - 本脚本仅供学习与研究自动化技术使用，严禁用于违反交易所规则的行为。
 *   - 频繁刷单可能导致账号风控、冻结等风险，请谨慎使用。
 *   - 刷分期间建议偶尔移动鼠标或进行简单页面交互，以减少被风控系统判定为异常行为的风险。
 *   - 交易所 UI 可能更新，请根据实际页面结构调整选择器。
 *   - 建议在测试账号或模拟盘环境下使用。
 *   - DYOR！！！
 *
 * MIT License
 */

// === 全局参数配置 ===
/** 买入价格（建议略低于市价，单位：币种） */
let ORDER_PRICE_BUY = 48.004839;
/** 卖出价格（建议略高于市价，单位：币种） */
let ORDER_PRICE_SELL = 48.0048361;
/** 每次买/卖的数量（单位：币种） */
const ORDER_VOLUME = 10;
/** 最大刷单轮数（即买入+卖出为一轮） */
const MAX_TRADES = 13;
/** 单笔订单最大等待成交时间（毫秒），超时未成交则提示人工干预。*/
const ORDER_TIMEOUT_MS = 300000;
/** 遇到价格警告弹窗时是否中止（true/false） */
const ABORT_ON_PRICE_WARNING = false;
/** 是否启用动态价格设定（true/false） */
const ENABLE_DYNAMIC_PRICING = false;
/** 动态价格偏移量（买入价格 = 分布最多价格 + 偏移量，卖出价格 = 分布最多价格 - 偏移量） */
/** 如果给 0 则代表在分布价格上不加价也不减价，但可能会出手比较慢 */
const PRICE_OFFSET = 0.00000000;
/** 24 小时成交量最低要求（单位：M）不推荐刷成交量太低的币，潜在大波动 */
const MIN_VOLUME_M = 500;

// === 强制中断支持 ===
let stopTrading = false;
window.stopAlphaTrading = () => {
  stopTrading = true;
  logit("已收到 stopAlphaTrading 指令，自动刷单将尽快中断...");
};

// 订单类型常量
const ORDER_TYPE = {
  BUY: "buy",
  SELL: "sell",
};

// 选择器配置（如需适配其他交易所请修改此处）
const SELECTORS = {
  [ORDER_TYPE.BUY]: {
    button: ".bn-button.bn-button__buy",
    logPrefix: "买入",
  },
  [ORDER_TYPE.SELL]: {
    button: ".bn-button.bn-button__sell",
    logPrefix: "卖出",
  },
  limitTab: "#bn-tab-LIMIT",
  priceInput: "#limitPrice",
  volumeInput: "#limitTotal",
  confirmModal: ".bn-modal-confirm",
  feeModal: ".bn-trans.data-show.bn-mask.bn-modal",
};

/**
 * 日志输出，带时间戳和统一前缀
 * @param {...any} args
 */
function logit() {
  const args = Array.from(arguments);
  const timestamp = new Date().toISOString();
  const prefix = `BNAlpha - ${timestamp}:`;
  if (args.length > 0) {
    if (typeof args[0] === "string") {
      args[0] = `${prefix} ${args[0]}`;
    } else {
      args.unshift(prefix);
    }
  } else {
    args.push(prefix);
  }
  console.log.apply(console, args);
}

/**
 * 等待元素出现并可选执行操作
 * @param {string|Function} selector - CSS选择器或返回元素的函数
 * @param {Function|null} checker - 可选的元素检查函数
 * @param {Function|null} onReady - 元素出现后要执行的操作（接收元素作为参数，可为async）
 * @param {number} maxAttempts - 最大尝试次数
 * @param {number} interval - 重试间隔(毫秒)
 * @param {number} initialDelay - 初始延迟(毫秒)
 * @returns {Promise<any>} - 返回 onReady 的结果
 */
function waitForElement(
  selector,
  checker = null,
  onReady = null,
  maxAttempts = 10,
  interval = 2000,
  initialDelay = 1000
) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      let attempts = 0;
      function attempt() {
        let el = null;
        try {
          el =
            typeof selector === "string"
              ? document.querySelector(selector)
              : selector();
        } catch (e) {
          el = null;
        }
        if (el && (!checker || checker(el))) {
          if (onReady) {
            Promise.resolve(onReady(el)).then(resolve).catch(reject);
          } else {
            resolve(el);
          }
        } else {
          attempts++;
          if (attempts < maxAttempts) {
            setTimeout(attempt, interval);
          } else {
            reject(new Error("元素未找到: " + selector));
          }
        }
      }
      attempt();
    }, initialDelay);
  });
}

/**
 * 通过文本内容获取买入/卖出tab
 * @param {string} text - tab文本（如“买入”或“卖出”）
 * @returns {HTMLElement|null}
 */
function getTabByText(text) {
  const tabs = document.querySelectorAll(".bn-tab.bn-tab__buySell");
  return Array.from(tabs).find((tab) => tab.textContent.trim() === text);
}

/**
 * 获取已激活的买入/卖出tab
 * @param {string} text - tab文本
 * @returns {HTMLElement|null}
 */
function getActiveTabByText(text) {
  const tabs = document.querySelectorAll(".bn-tab.bn-tab__buySell");
  return Array.from(tabs).find(
    (tab) =>
      tab.textContent.trim() === text &&
      tab.classList.contains("active") &&
      tab.getAttribute("aria-selected") === "true"
  );
}

/**
 * 设置输入框的值并触发input/change事件
 * @param {HTMLElement} inputElement - 目标输入框元素
 * @param {string|number} value - 要设置的值
 */
function setInputValue(inputElement, value) {
  if (!inputElement) return;
  inputElement.focus();
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value"
  ).set;
  nativeInputValueSetter.call(inputElement, "");
  nativeInputValueSetter.call(inputElement, value);
  inputElement.dispatchEvent(new Event("input", { bubbles: true }));
  inputElement.dispatchEvent(new Event("change", { bubbles: true }));
  inputElement.blur();
}

/**
 * 设置买入/卖出数量（仅买入时用）
 * @param {number} amount
 */
function setVolume(amount) {
  const input = document.querySelector(SELECTORS.volumeInput);
  if (input) setInputValue(input, amount);
}

/**
 * 设置限价价格
 * @param {number} price
 */
function setLimitPrice(price) {
  const input = document.querySelector(SELECTORS.priceInput);
  if (input) setInputValue(input, price);
}

/**
 * 检查订单状态，判断是否已成交
 * @returns {Promise<{status: string, message?: string}>}
 */
function checkOrderStatus() {
  const orderTab = document.querySelector("#bn-tab-orderOrder");
  const limitTab = document.querySelector("#bn-tab-limit");
  if (orderTab) orderTab.click();
  if (limitTab) limitTab.click();
  return new Promise((resolve, reject) => {
    let finished = false;
    let timeoutId = null;
    const checkOrder = () => {
      if (finished) return;
      // 检查“无进行中的订单”提示
      const noOrderTip = Array.from(
        document.querySelectorAll("div.text-TertiaryText")
      ).find((div) => div.textContent.includes("无进行中的订单"));
      if (noOrderTip) {
        finished = true;
        if (timeoutId) clearTimeout(timeoutId);
        resolve({ status: "completed" });
        return;
      }
      // 兼容旧逻辑（如有表格）
      const tbody = document.querySelector(".bn-web-table-tbody");
      if (tbody && tbody.children && tbody.children.length > 0) {
        setTimeout(checkOrder, 1000 + Math.random() * 2000); // 1~3秒随机延迟
      } else {
        setTimeout(checkOrder, 1000 + Math.random() * 2000); // 1~3秒随机延迟
      }
    };
    setTimeout(checkOrder, 1000 + Math.random() * 2000);
    timeoutId = setTimeout(() => {
      if (finished) return;
      finished = true;
      logit("订单超时未成交");
      alert("订单可能无法正常成交,请人工检查并调整价格");
      resolve({
        status: "timeout",
        message: "订单超时未成交,需要人工干预",
      });
    }, ORDER_TIMEOUT_MS);
  });
}

/**
 * 通用下单函数（买入/卖出）
 * @param {Object} options
 * @param {'buy'|'sell'} options.type - 订单类型
 * @param {number} options.price - 价格
 * @param {number} options.volume - 数量
 * @param {boolean} options.abortOnPriceWarning - 是否遇到价格警告时中止
 * @returns {Promise<{status: string, message?: string}>}
 */
async function placeOrder({
  type,
  price,
  volume,
  abortOnPriceWarning = false,
}) {
  // 1. 切换到买/卖tab
  const tabText = type === ORDER_TYPE.BUY ? "买入" : "卖出";
  const tab = await waitForElement(() => getTabByText(tabText));
  if (!tab) throw new Error("未找到" + tabText + "tab");
  tab.click();
  logit(`已点击${tabText}标签`);
  await waitForElement(() => getActiveTabByText(tabText));
  logit(`${tabText}标签已激活`);
  // 2. 切换到限价
  const limitTab = await waitForElement(SELECTORS.limitTab);
  if (!limitTab) throw new Error("未找到限价tab");
  limitTab.click();
  logit("已点击限价标签");

  // 3. 卖出时优先将滑块拉满（百分比100%），并判断是否有可卖资产
  if (type === ORDER_TYPE.SELL) {
    const slider = document.querySelector('input[role="slider"]');
    if (slider) {
      setInputValue(slider, 100);
      if (slider.value === "0") {
        logit("卖出失败，无存货");
        return { status: "no_stock", message: "无可卖资产" };
      }
    }
  }

  // 4. 设置价格
  setLimitPrice(price);

  // 5. 买入才设置数量
  if (type === ORDER_TYPE.BUY) {
    setVolume(volume);
  }
  logit(
    `已设置限价${price}` +
      (type === ORDER_TYPE.BUY ? `和数量${volume}` : "，全部可卖资产")
  );

  // 6. 点击买/卖按钮
  const config = SELECTORS[type];
  const actionButton = await waitForElement(config.button);
  if (!actionButton) throw new Error("未找到" + config.logPrefix + "按钮");
  actionButton.click();
  logit(`已点击${config.logPrefix}按钮`);
  // 7. 检查价格警告弹窗
  try {
    const confirmModal = await waitForElement(
      SELECTORS.confirmModal,
      null,
      null,
      3,
      500,
      500
    );
    if (confirmModal && confirmModal.textContent.includes("下单手滑提醒")) {
      if (abortOnPriceWarning) {
        logit("检测到下单手滑提醒,停止交易");
        alert("检测到下单手滑提醒,已停止交易");
        return { status: "aborted", message: "下单手滑提醒，已中止" };
      } else {
        logit("检测到下单手滑提醒,继续交易");
        const continueButton = await waitForElement(
          () => {
            const dialog = document.querySelector('div[role="dialog"]');
            if (!dialog) return null;
            const buttons = dialog.querySelectorAll("button");
            return Array.from(buttons).find((btn) =>
              btn.textContent.includes("继续")
            );
          },
          null,
          null,
          5,
          1000,
          0
        );
        if (continueButton && continueButton.textContent.includes("继续")) {
          continueButton.click();
          logit("已点击下单手滑提醒弹窗的继续按钮");
        }
      }
    }
  } catch (err) {
    // 如果没有弹窗出现就继续执行
  }
  // 8. 检查手续费弹窗
  try {
    const feeModal = await waitForElement(
      SELECTORS.feeModal,
      null,
      null,
      5,
      1000,
      0
    );
    if (feeModal && feeModal.textContent.includes("预估手续费")) {
      logit("检测到预估手续费弹窗");
      const confirmButton = await waitForElement(
        () => {
          const dialog = document.querySelector('div[role="dialog"]');
          if (!dialog) return null;
          const buttons = dialog.querySelectorAll("button");
          return Array.from(buttons).find((btn) =>
            btn.textContent.includes("继续")
          );
        },
        null,
        null,
        5,
        1000,
        0
      );
      if (confirmButton && confirmButton.textContent.includes("继续")) {
        confirmButton.click();
        logit("已点击预估手续费弹窗的继续按钮");
      }
    }
  } catch (e) {
    logit("未检测到预估手续费弹窗，继续...");
  }
  // 9. 等待订单成交
  const orderResult = await checkOrderStatus();
  logit("订单状态:", orderResult);
  return orderResult || { status: "unknown" };
}

/**
 * 买入操作
 * @param {number} price - 买入价格
 * @param {number} volume - 买入数量
 * @param {boolean} abortOnPriceWarning - 是否遇到价格警告时中止
 * @returns {Promise<{status: string, message?: string}>}
 */
async function buy(price, volume, abortOnPriceWarning = false) {
  return placeOrder({
    type: ORDER_TYPE.BUY,
    price,
    volume,
    abortOnPriceWarning,
  });
}

/**
 * 从成交记录中获取最新价格，分别计算买入和卖出价格
 * @returns {Promise<{buyPrice: number, sellPrice: number, error?: string}|null>}
 */
async function getDynamicPrices() {
  try {
    // 等待成交记录区域加载
    await waitForElement('.ReactVirtualized__Grid', null, null, 5, 1000, 500);
    
    // 分别获取买入和卖出的价格元素
    const buyPriceElements = document.querySelectorAll('.ReactVirtualized__Grid .flex-1[style*="color: var(--color-Buy)"]');
    const sellPriceElements = document.querySelectorAll('.ReactVirtualized__Grid .flex-1[style*="color: var(--color-Sell)"]');
    
    if (buyPriceElements.length === 0 && sellPriceElements.length === 0) {
      logit("未找到成交记录价格元素");
      return { error: "未找到成交记录价格元素" };
    }
    
    // 分别处理买入和卖出价格
    const buyPrices = [];
    const sellPrices = [];
    
    // 处理买入价格
    buyPriceElements.forEach(el => {
      const priceText = el.textContent.trim();
      const price = parseFloat(priceText);
      if (!isNaN(price)) {
        buyPrices.push(price);
      }
    });
    
    // 处理卖出价格
    sellPriceElements.forEach(el => {
      const priceText = el.textContent.trim();
      const price = parseFloat(priceText);
      if (!isNaN(price)) {
        sellPrices.push(price);
      }
    });
    
    if (buyPrices.length === 0 && sellPrices.length === 0) {
      logit("无法解析成交记录中的价格");
      return { error: "无法解析成交记录中的价格" };
    }
    
    // 分别计算买入和卖出的分布最多价格
    let buyPrice = ORDER_PRICE_BUY; // 默认使用配置的买入价格
    let sellPrice = ORDER_PRICE_SELL; // 默认使用配置的卖出价格
    
    // 计算买入价格分布
    if (buyPrices.length > 0) {
      const recentBuyPrices = buyPrices.slice(0, Math.min(20, buyPrices.length));
      const buyPriceCount = {};
      recentBuyPrices.forEach(price => {
        const roundedPrice = Math.round(price * 100000000) / 100000000;
        buyPriceCount[roundedPrice] = (buyPriceCount[roundedPrice] || 0) + 1;
      });
      
      let mostFrequentBuyPrice = null;
      let maxBuyCount = 0;
      for (const [price, count] of Object.entries(buyPriceCount)) {
        if (count > maxBuyCount) {
          maxBuyCount = count;
          mostFrequentBuyPrice = parseFloat(price);
        }
      }
      
      if (mostFrequentBuyPrice) {
        mostFrequentBuyPrice = Math.round(mostFrequentBuyPrice * 100000000) / 100000000;
        buyPrice = Math.round((mostFrequentBuyPrice + PRICE_OFFSET) * 100000000) / 100000000;
        logit(`买入价格计算 - 分布最多买入价格: ${mostFrequentBuyPrice} (出现${maxBuyCount}次), 最终买入价格: ${buyPrice}`);
      }
    }
    
    // 计算卖出价格分布
    if (sellPrices.length > 0) {
      const recentSellPrices = sellPrices.slice(0, Math.min(20, sellPrices.length));
      const sellPriceCount = {};
      recentSellPrices.forEach(price => {
        const roundedPrice = Math.round(price * 100000000) / 100000000;
        sellPriceCount[roundedPrice] = (sellPriceCount[roundedPrice] || 0) + 1;
      });
      
      let mostFrequentSellPrice = null;
      let maxSellCount = 0;
      for (const [price, count] of Object.entries(sellPriceCount)) {
        if (count > maxSellCount) {
          maxSellCount = count;
          mostFrequentSellPrice = parseFloat(price);
        }
      }
      
      if (mostFrequentSellPrice) {
        mostFrequentSellPrice = Math.round(mostFrequentSellPrice * 100000000) / 100000000;
        sellPrice = Math.round((mostFrequentSellPrice - PRICE_OFFSET) * 100000000) / 100000000;
        logit(`卖出价格计算 - 分布最多卖出价格: ${mostFrequentSellPrice} (出现${maxSellCount}次), 最终卖出价格: ${sellPrice}`);
      }
    }
    
    // 价格异常检测
    const priceDiff = Math.abs(buyPrice - sellPrice);
    const priceRatio = priceDiff / Math.min(buyPrice, sellPrice);
    
    // 如果价格差异过大（超过1%）或价格为0或负数，认为异常
    if (buyPrice <= 0 || sellPrice <= 0) {
      const errorMsg = `价格异常：买入价格=${buyPrice}, 卖出价格=${sellPrice}`;
      logit(errorMsg);
      return { error: errorMsg };
    }
    
    if (priceRatio > 0.01) {
      const errorMsg = `价格差异过大：买入价格=${buyPrice}, 卖出价格=${sellPrice}, 差异比例=${(priceRatio * 100).toFixed(2)}%`;
      logit(errorMsg);
      return { error: errorMsg };
    }
    
    // 检查价格是否与配置价格差异过大（超过10%）
    const buyPriceDiff = Math.abs(buyPrice - ORDER_PRICE_BUY) / ORDER_PRICE_BUY;
    const sellPriceDiff = Math.abs(sellPrice - ORDER_PRICE_SELL) / ORDER_PRICE_SELL;
    
    if (buyPriceDiff > 0.1 || sellPriceDiff > 0.1) {
      const errorMsg = `动态价格与配置价格差异过大：买入价格=${buyPrice} (配置=${ORDER_PRICE_BUY}), 卖出价格=${sellPrice} (配置=${ORDER_PRICE_SELL})`;
      logit(errorMsg);
      return { error: errorMsg };
    }
    
    // 调试输出
    logit(`调试 - 买入偏移量: +${PRICE_OFFSET}, 卖出偏移量: -${PRICE_OFFSET}`);
    logit(`动态价格计算完成 - 买入价格: ${buyPrice}, 卖出价格: ${sellPrice}`);
    
    return { buyPrice, sellPrice };
  } catch (error) {
    logit("获取动态价格失败:", error);
    return { error: `获取动态价格失败: ${error.message}` };
  }
}

/**
 * 卖出操作
 * @param {number} price - 卖出价格
 * @param {number} volume - 卖出数量
 * @param {boolean} abortOnPriceWarning - 是否遇到价格警告时中止
 * @returns {Promise<{status: string, message?: string}>}
 */
async function sell(price, volume, abortOnPriceWarning = false) {
  return placeOrder({
    type: ORDER_TYPE.SELL,
    price,
    volume,
    abortOnPriceWarning,
  });
}

/**
 * 检查24h成交量是否足够，不足500M则不刷单
 * @returns {Promise<boolean>} 成交量是否足够
 */
async function checkVolumeBeforeTrading() {
  try {
    // 等待成交量元素加载
    const volumeElement = await waitForElement(
      () => {
        const elements = document.querySelectorAll('div.text-TertiaryText');
        return Array.from(elements).find(el => el.textContent.includes('24h成交量'));
      },
      null,
      null,
      5,
      1000,
      500
    );
    
    if (!volumeElement) {
      logit("未找到24h成交量元素");
      return false;
    }
    
    // 获取成交量数值
    const volumeText = volumeElement.nextElementSibling?.textContent;
    if (!volumeText) {
      logit("未找到成交量数值");
      return false;
    }
    
    logit(`检测到24h成交量: ${volumeText}`);
    
    // 解析成交量数值
    const match = volumeText.match(/\$([\d.]+)([KMBT])?/);
    if (!match) {
      logit("无法解析成交量格式");
      return false;
    }
    
    const value = parseFloat(match[1]);
    const unit = match[2] || '';
    
    // 转换为M单位进行比较
    let volumeInM = 0;
    switch (unit) {
      case 'T':
        volumeInM = value * 1000000; // 1T = 1,000,000M
        break;
      case 'B':
        volumeInM = value * 1000; // 1B = 1,000M
        break;
      case 'M':
        volumeInM = value;
        break;
      case 'K':
        volumeInM = value / 1000; // 1K = 0.001M
        break;
      default:
        volumeInM = value / 1000000; // 假设无单位时为美元，转换为M
        break;
    }
    
    logit(`成交量转换为M单位: ${volumeInM}M`);
    
    if (volumeInM < MIN_VOLUME_M) {
      alert(`24 小时成交量低于 ${MIN_VOLUME_M}M (当前: ${volumeInM}M)，检查未通过，停止自动刷单`);
      return false;
    }
    
    logit(`成交量充足 (${volumeInM}M)，可以开始刷单`);
    return true;
  } catch (error) {
    logit("检查成交量时出错:", error);
    return false;
  }
}

/**
 * 主交易循环，自动买入卖出刷交易量
 */
async function startTrading() {
  // 开始前检查成交量
  const volumeOk = await checkVolumeBeforeTrading();
  if (!volumeOk) {
    logit("成交量检查未通过，停止自动刷单");
    return;
  }
  
  // 成交量检查通过，弹窗提示开始刷单
  logit("成交量检查通过，开始自动刷单");
  
  let tradeCount = 0;
  while (tradeCount < MAX_TRADES) {
    if (stopTrading) {
      logit("检测到 stopTrading 标志，自动刷单已被强制中断");
      break;
    }
    
    try {
      // 动态价格设定
      let currentBuyPrice = ORDER_PRICE_BUY;
      let currentSellPrice = ORDER_PRICE_SELL;
      
      if (ENABLE_DYNAMIC_PRICING) {
        logit("启用动态价格设定，正在获取最新价格...");
        const dynamicPrices = await getDynamicPrices();
        if (dynamicPrices && !dynamicPrices.error) {
          currentBuyPrice = dynamicPrices.buyPrice;
          currentSellPrice = dynamicPrices.sellPrice;
          logit(`第${tradeCount + 1}轮使用动态价格 - 买入: ${currentBuyPrice}, 卖出: ${currentSellPrice}`);
        } else {
          logit("动态价格获取失败，使用默认价格");
        }
      } else {
        logit(`第${tradeCount + 1}轮使用固定价格 - 买入: ${currentBuyPrice}, 卖出: ${currentSellPrice}`);
      }
      
      logit(`开始第${tradeCount + 1}次买入...`);
      const buyResult = await buy(
        currentBuyPrice,
        ORDER_VOLUME,
        ABORT_ON_PRICE_WARNING
      );
      logit("本次买入返回:", buyResult);
      if (buyResult && buyResult.status === "completed") {
        logit("买入成功,开始卖出...");
        const sellResult = await sell(
          currentSellPrice,
          ORDER_VOLUME,
          ABORT_ON_PRICE_WARNING
        );
        logit("本次卖出返回:", sellResult);
        if (sellResult && sellResult.status === "completed") {
          logit("卖出成功,继续下一轮交易");
          tradeCount++;
        } else {
          logit("卖出失败,暂停交易，返回值:", sellResult);
          alert("卖出失败,已停止交易");
          break;
        }
      } else {
        logit("买入失败,暂停交易，返回值:", buyResult);
        alert("买入失败,已停止交易");
        break;
      }
      // 每轮交易间隔1-2秒，防止被风控
      await new Promise((resolve) =>
        setTimeout(resolve, 1000 + Math.random() * 1000)
      );
    } catch (err) {
      logit("交易出错:", err);
      alert(`交易出错: ${err.message}`);
      break;
    }
  }
  if (tradeCount >= MAX_TRADES) {
    logit("已完成设定的交易次数");
    alert("已完成设定的交易次数");
  }
}

// === 启动自动交易 ===
startTrading();