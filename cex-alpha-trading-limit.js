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
 * @param {string} text - tab文本（如"买入"或"卖出"）
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
      // 检查"无进行中的订单"提示
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
    
    // 分别处理买入价格
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

// === 交易量计算功能 ===

/**
 * 点击委托历史标签页
 */
async function clickOrderHistoryTabForVolumeCalc() {
  try {
    // 查找委托历史标签页
    const orderHistoryTab = document.querySelector('[id="bn-tab-orderHistory"]');
    if (!orderHistoryTab) {
      logit("未找到委托历史标签页");
      return false;
    }
    
    // 点击标签页
    orderHistoryTab.click();
    logit("已点击委托历史标签页");
    
    // 等待页面加载
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // 限制在指定的容器内查找元素
    const tradeContainer = document.querySelector('div.bg-TradeBg div.order-6');
    if (!tradeContainer) {
      logit("未找到交易容器");
      return false;
    }
    
    // 点击「限价」标签 - 限制在容器内查找
    try {
      const limitPriceTab = tradeContainer.querySelector('#bn-tab-0');
      if (limitPriceTab) {
        limitPriceTab.click();
        logit("已点击「限价」标签");
        await new Promise(resolve => setTimeout(resolve, 1000));
      } else {
        logit("未找到「限价」标签");
      }
    } catch (error) {
      logit("点击「限价」标签失败:", error);
    }
    
    // 点击「1天」时间范围 - 限制在容器内查找
    try {
      // 查找包含"1天"文本的div元素
      let oneDayButton = null;
      const divs = tradeContainer.querySelectorAll('div');
      
      for (const div of divs) {
        if (div.textContent === '1天') {
          oneDayButton = div;
          break;
        }
      }
      
      if (!oneDayButton) {
        // 查找具有特定样式的按钮（通过CSS变量背景色）
        const buttons = tradeContainer.querySelectorAll('div[style*="background-color: var(--color-bg3)"]');
        for (const button of buttons) {
          if (button.textContent === '1天') {
            oneDayButton = button;
            break;
          }
        }
      }
      
      if (!oneDayButton) {
        // 查找所有可能的时间范围按钮
        const timeButtons = tradeContainer.querySelectorAll('div[style*="min-width: 48px"]');
        for (const button of timeButtons) {
          if (button.textContent === '1天') {
            oneDayButton = button;
            break;
          }
        }
      }
      
      if (oneDayButton) {
        oneDayButton.click();
        logit("已点击「1天」时间范围");
        await new Promise(resolve => setTimeout(resolve, 1000));
      } else {
        logit("未找到「1天」时间范围按钮，尝试查找所有时间按钮...");
        // 输出所有可能的时间按钮，帮助调试
        const allButtons = tradeContainer.querySelectorAll('div');
        const timeButtons = [];
        for (const button of allButtons) {
          const text = button.textContent?.trim();
          if (text && ['1天', '1周', '1个月', '6 个月'].includes(text)) {
            timeButtons.push({ text, element: button });
          }
        }
        if (timeButtons.length > 0) {
          logit(`找到时间按钮: ${timeButtons.map(b => b.text).join(', ')}`);
        }
      }
    } catch (error) {
      logit("点击「1天」时间范围失败:", error);
    }
    
    // 等待表格加载
    await new Promise(resolve => setTimeout(resolve, 2000));
    return true;
  } catch (error) {
    logit("点击委托历史标签页失败:", error);
    return false;
  }
}

/**
 * 解析交易行数据
 * @param {Element} row - 表格行元素
 * @returns {Object|null} 解析后的交易数据
 */
function parseTradeRowForVolumeCalc(row) {
  try {
    const cells = row.querySelectorAll('.bn-web-table-cell');
    if (cells.length < 11) {
      logit(`DEBUG: 单元格数量不足，期望11个，实际${cells.length}个`);
      return null;
    }
    
    // 获取时间（第2列，索引1）
    const timeText = cells[1]?.textContent?.trim();
    if (!timeText) {
      logit(`DEBUG: 时间文本为空`);
      return null;
    }
    
    // 获取交易方向（第5列，索引4）
    const directionElement = cells[4]?.querySelector('div');
    const direction = directionElement?.textContent?.trim();
    if (!direction) {
      logit(`DEBUG: 交易方向为空，原始内容: ${cells[4]?.textContent}`);
      return null;
    }
    
    // 获取已成交数量（第8列，索引7）
    const filledText = cells[7]?.textContent?.trim();
    if (!filledText) {
      logit(`DEBUG: 已成交数量为空`);
      return null;
    }
    
    // 获取状态（第11列，索引10）
    const statusElement = cells[10]?.querySelector('div');
    const status = statusElement?.textContent?.trim();
    if (!status) {
      logit(`DEBUG: 状态为空，原始内容: ${cells[10]?.textContent}`);
      return null;
    }
    
    // 只处理已成交的订单（买入和卖出都处理）
    if (status !== '已成交') {
      logit(`DEBUG: 订单状态不是已成交: ${status}`);
      return null;
    }
    
    // 检查是否为买入或卖出
    if (!direction.includes('买入') && !direction.includes('卖出')) {
      logit(`DEBUG: 交易方向不是买入或卖出: ${direction}`);
      return null;
    }
    
    // 解析时间
    const date = new Date(timeText);
    if (isNaN(date.getTime())) {
      logit(`DEBUG: 时间解析失败: ${timeText}`);
      return null;
    }
    
    // 解析数量（提取数字部分）
    const volumeMatch = filledText.match(/[\d.]+/);
    const volume = volumeMatch ? Math.round(parseFloat(volumeMatch[0]) * 100000000) / 100000000 : 0;
    
    if (volume === 0) {
      logit(`DEBUG: 数量解析失败或为0: ${filledText}`);
      return null;
    }
    
    logit(`DEBUG: 数量解析结果: ${volume}`);
    
    // 尝试获取价格信息（从第7列，索引6，价格列）
    let price = 0;
    try {
      const priceText = cells[6]?.textContent?.trim();
      logit(`DEBUG: 价格原始文本: "${priceText}"`);
      
      if (priceText) {
        const priceMatch = priceText.match(/[\d.]+/);
        if (priceMatch) {
          // 使用8位小数精度进行计算
          price = Math.round(parseFloat(priceMatch[0]) * 100000000) / 100000000;
          logit(`DEBUG: 价格解析结果: ${price}`);
        } else {
          logit(`DEBUG: 价格正则匹配失败`);
        }
      } else {
        logit(`DEBUG: 价格文本为空`);
      }
    } catch (error) {
      logit(`DEBUG: 价格解析失败: ${error.message}`);
    }
    
    // 获取成交额（从第10列，索引9，成交额列）
    let totalValue = 0;
    try {
      const totalValueText = cells[9]?.textContent?.trim();
      logit(`DEBUG: 成交额原始文本: "${totalValueText}"`);
      
      if (totalValueText) {
        // 提取数字部分，包括小数点，去掉USDT等后缀
        const totalValueMatch = totalValueText.match(/[\d,]+\.?\d*/);
        if (totalValueMatch) {
          // 使用更精确的浮点数处理，避免精度丢失
          const cleanValue = totalValueMatch[0].replace(/,/g, '');
          // 使用8位小数精度进行计算
          totalValue = Math.round(parseFloat(cleanValue) * 100000000) / 100000000;
          logit(`DEBUG: 成交额解析结果: ${totalValue} (原始: ${cleanValue})`);
        } else {
          logit(`DEBUG: 成交额正则匹配失败`);
        }
      } else {
        logit(`DEBUG: 成交额文本为空`);
      }
    } catch (error) {
      logit(`DEBUG: 成交额解析失败: ${error.message}`);
    }
    
    const result = {
      time: date,
      direction: direction,
      volume: volume,
      status: status,
      rawTime: timeText,
      price: price,
      totalValue: totalValue,
      isBuy: direction.includes('买入'),
      isSell: direction.includes('卖出')
    };
    
    logit(`DEBUG: 成功解析交易行 - 时间: ${timeText}, 方向: ${direction}, 数量: ${volume}, 成交额: ${totalValue}, 价格: ${price}`);
    
    return result;
    
  } catch (error) {
    logit("解析交易行数据失败:", error);
    return null;
  }
}

/**
 * 获取当前页面的交易数据
 * @returns {Array} 交易数据数组
 */
function getCurrentPageTradesForVolumeCalc() {
  const trades = [];
  try {
    // 尝试多种表格选择器
    let rows = document.querySelectorAll('.bn-web-table-tbody .bn-web-table-row:not(.bn-web-table-measure-row)');
    
    if (rows.length === 0) {
      // 尝试更宽泛的选择器
      rows = document.querySelectorAll('table tbody tr');
      logit(`DEBUG: 使用 table tbody tr 选择器，找到 ${rows.length} 行`);
    }
    
    if (rows.length === 0) {
      // 尝试查找所有可能的行
      rows = document.querySelectorAll('tbody tr');
      logit(`DEBUG: 使用 tbody tr 选择器，找到 ${rows.length} 行`);
    }
    
    logit(`DEBUG: 最终找到 ${rows.length} 行数据`);
    
    // 遍历每一行
    rows.forEach((row, index) => {
      // 检查行是否包含必要的单元格
      const cells = row.querySelectorAll('.bn-web-table-cell');
      
      logit(`DEBUG: 第${index + 1}行 - 单元格数量: ${cells.length}`);
      
      if (cells.length >= 11) {
        // 尝试解析这一行
        const tradeData = parseTradeRowForVolumeCalc(row);
        if (tradeData) {
          trades.push(tradeData);
          logit(`DEBUG: 第${index + 1}行解析成功`);
        } else {
          logit(`DEBUG: 第${index + 1}行解析失败`);
        }
      } else {
        logit(`DEBUG: 第${index + 1}行单元格数量不足，跳过`);
        // 输出行的HTML结构用于调试
        if (index < 3) { // 只输出前3行的详细信息
          logit(`DEBUG: 第${index + 1}行HTML结构:`, row.outerHTML.substring(0, 200) + '...');
        }
      }
    });
    
    logit(`DEBUG: 当前页面解析到 ${trades.length} 笔交易订单`);
    
    // 输出前几笔交易的详细信息用于调试
    if (trades.length > 0) {
      logit(`DEBUG: 前3笔交易详情:`);
      trades.slice(0, 3).forEach((trade, index) => {
        logit(`DEBUG: 交易${index + 1} - 时间: ${trade.rawTime}, 方向: ${trade.direction}, 数量: ${trade.volume}, 成交额: ${trade.totalValue}`);
      });
    }
    
  } catch (error) {
    logit("获取当前页面交易数据失败:", error);
  }
  
  return trades;
}

/**
 * 检查是否有下一页
 * @returns {boolean} 是否有下一页
 */
function hasNextPageForVolumeCalc() {
  try {
    // 查找下一页按钮 - 根据实际HTML结构调整
    const nextButton = document.querySelector('.bn-pagination-next:not(.disabled)') ||
                      document.querySelector('.bn-pagination-next[aria-disabled="false"]') ||
                      document.querySelector('button[aria-label="下一页"]') || 
                      document.querySelector('button[title="下一页"]') ||
                      document.querySelector('.pagination-next') ||
                      document.querySelector('[data-testid="pagination-next"]');
    
    if (!nextButton) {
      logit("未找到下一页按钮");
      return false;
    }
    
    // 检查按钮是否可用
    const isDisabled = nextButton.classList.contains('disabled') || 
                      nextButton.getAttribute('aria-disabled') === 'true';
    
    logit(`下一页按钮状态: ${isDisabled ? '已禁用' : '可用'}`);
    return !isDisabled;
  } catch (error) {
    logit("检查下一页失败:", error);
    return false;
  }
}

/**
 * 点击下一页
 * @returns {boolean} 是否成功点击
 */
async function clickNextPageForVolumeCalc() {
  try {
    // 查找下一页按钮 - 根据实际HTML结构调整
    const nextButton = document.querySelector('.bn-pagination-next:not(.disabled)') ||
                      document.querySelector('.bn-pagination-next[aria-disabled="false"]') ||
                      document.querySelector('button[aria-label="下一页"]') || 
                      document.querySelector('button[title="下一页"]') ||
                      document.querySelector('.pagination-next') ||
                      document.querySelector('[data-testid="pagination-next"]');
    
    if (!nextButton) {
      logit("未找到下一页按钮");
      return false;
    }
    
    // 检查按钮是否可用
    const isDisabled = nextButton.classList.contains('disabled') || 
                      nextButton.getAttribute('aria-disabled') === 'true';
    
    if (isDisabled) {
      logit("下一页按钮已禁用，无法点击");
      return false;
    }
    
    logit("点击下一页按钮...");
    nextButton.click();
    logit("已点击下一页");
    
    // 等待页面加载
    await new Promise(resolve => setTimeout(resolve, 2000));
    return true;
  } catch (error) {
    logit("点击下一页失败:", error);
    return false;
  }
}

/**
 * 计算每日交易量（8点到次日8点）
 * @param {Array} trades - 所有交易数据
 * @returns {Object} 按日期分组的交易量统计
 */
function calculateDailyVolumeForVolumeCalc(trades) {
  const dailyStats = {};
  
  // 获取今日日期（考虑8点分界）
  const now = new Date();
  let today;
  if (now.getHours() < 8) {
    // 如果当前时间在8点前，今日是昨天
    today = new Date(now);
    today.setDate(today.getDate() - 1);
    logit(`DEBUG: 当前时间 ${now.toLocaleString()} 在8点前，今日日期调整为: ${today.toISOString().split('T')[0]}`);
  } else {
    // 如果当前时间在8点后，今日是今天
    today = new Date(now);
    logit(`DEBUG: 当前时间 ${now.toLocaleString()} 在8点后，今日日期为: ${today.toISOString().split('T')[0]}`);
  }
  today.setHours(8, 0, 0, 0);
  const todayKey = today.toISOString().split('T')[0];
  
  logit(`DEBUG: 今日日期（8点分界）: ${todayKey}`);
  logit(`DEBUG: 总共需要处理的交易数量: ${trades.length}`);
  
  let processedCount = 0;
  let todayCount = 0;
  
  trades.forEach((trade, index) => {
    processedCount++;
    
    // 调整时间：如果时间在0-7:59，算作前一天的交易
    // 如果时间在8:00-23:59，算作当天的交易
    let tradeDate = new Date(trade.time);
    const originalDate = new Date(trade.time);
    const originalHours = tradeDate.getHours();
    
    logit(`DEBUG: 处理第${processedCount}笔交易 - 原始时间: ${trade.rawTime}, 原始小时: ${originalHours}`);
    
    if (tradeDate.getHours() < 8) {
      tradeDate.setDate(tradeDate.getDate() - 1);
      logit(`DEBUG: 时间在8点前，日期调整为: ${tradeDate.toISOString().split('T')[0]}`);
    } else {
      logit(`DEBUG: 时间在8点后，保持原日期: ${tradeDate.toISOString().split('T')[0]}`);
    }
    
    // 设置时间为8点
    tradeDate.setHours(8, 0, 0, 0);
    
    const dateKey = tradeDate.toISOString().split('T')[0];
    
    logit(`DEBUG: 交易归属日期: ${dateKey}, 是否今日: ${dateKey === todayKey}`);
    
    // 只统计今日的交易
    if (dateKey === todayKey) {
      todayCount++;
      if (!dailyStats[dateKey]) {
        dailyStats[dateKey] = {
          date: dateKey,
          totalVolume: 0, // KOGE总量
          totalValue: 0, // USDT成交额总量
          tradeCount: 0,
          trades: [],
          buyTrades: [],
          sellTrades: [],
          totalBuyVolume: 0, // KOGE买入量
          totalSellVolume: 0, // KOGE卖出量
          totalBuyValue: 0, // USDT买入成交额
          totalSellValue: 0, // USDT卖出成交额
          wearLoss: 0, // 磨损损失（USDT）
          wearLossPercentage: 0 // 磨损百分比
        };
      }
      
      dailyStats[dateKey].totalVolume += trade.volume; // KOGE总量
      dailyStats[dateKey].tradeCount += 1;
      dailyStats[dateKey].trades.push(trade);
      
      logit(`DEBUG: 今日第${todayCount}笔交易 - 方向: ${trade.direction}, 数量: ${trade.volume}, 成交额: ${trade.totalValue}`);
      
      // 分别统计买入和卖出
      if (trade.isBuy) {
        dailyStats[dateKey].buyTrades.push(trade);
        dailyStats[dateKey].totalBuyVolume = Math.round((dailyStats[dateKey].totalBuyVolume + trade.volume) * 100000000) / 100000000; // KOGE买入量
        dailyStats[dateKey].totalBuyValue = Math.round((dailyStats[dateKey].totalBuyValue + trade.totalValue) * 100000000) / 100000000; // USDT买入成交额
        // 成交总额只算买入
        dailyStats[dateKey].totalValue = Math.round((dailyStats[dateKey].totalValue + trade.totalValue) * 100000000) / 100000000;
        logit(`DEBUG: 买入交易 - 累计买入量: ${dailyStats[dateKey].totalBuyVolume}, 累计买入额: ${dailyStats[dateKey].totalBuyValue}`);
      } else if (trade.isSell) {
        dailyStats[dateKey].sellTrades.push(trade);
        dailyStats[dateKey].totalSellVolume = Math.round((dailyStats[dateKey].totalSellVolume + trade.volume) * 100000000) / 100000000; // KOGE卖出量
        dailyStats[dateKey].totalSellValue = Math.round((dailyStats[dateKey].totalSellValue + trade.totalValue) * 100000000) / 100000000; // USDT卖出成交额
        // 注意：成交总额不算卖出，只算买入
        logit(`DEBUG: 卖出交易 - 累计卖出量: ${dailyStats[dateKey].totalSellVolume}, 累计卖出额: ${dailyStats[dateKey].totalSellValue}`);
      }
    } else {
      logit(`DEBUG: 非今日交易，跳过 - 日期: ${dateKey}`);
    }
  });
  
  logit(`DEBUG: 处理完成 - 总交易数: ${processedCount}, 今日交易数: ${todayCount}`);
  
  // 计算磨损损失
  Object.keys(dailyStats).forEach(dateKey => {
    const stats = dailyStats[dateKey];
    
    logit(`DEBUG: 计算 ${dateKey} 的磨损统计`);
    logit(`DEBUG: 买入交易数: ${stats.buyTrades.length}, 卖出交易数: ${stats.sellTrades.length}`);
    
    if (stats.buyTrades.length > 0 && stats.sellTrades.length > 0) {
      // 计算平均买入价格和卖出价格（USDT）- 使用8位小数精度
      const avgBuyPrice = stats.totalBuyVolume > 0 ? Math.round((stats.totalBuyValue / stats.totalBuyVolume) * 100000000) / 100000000 : 0;
      const avgSellPrice = stats.totalSellVolume > 0 ? Math.round((stats.totalSellValue / stats.totalSellVolume) * 100000000) / 100000000 : 0;
      
      // 磨损 = 买入成交额 - 卖出成交额（USDT）- 使用8位小数精度
      stats.wearLoss = Math.round((stats.totalBuyValue - stats.totalSellValue) * 100000000) / 100000000;
      
      // 磨损百分比 = (磨损 / 买入成交额) * 100 - 使用8位小数精度
      if (stats.totalBuyValue > 0) {
        stats.wearLossPercentage = Math.round((stats.wearLoss / stats.totalBuyValue) * 100 * 100000000) / 100000000;
      }
      
      logit(`DEBUG: 磨损计算 - 总买入额: ${stats.totalBuyValue}, 总卖出额: ${stats.totalSellValue}`);
      logit(`DEBUG: 磨损计算 - 平均买入价: ${avgBuyPrice}, 平均卖出价: ${avgSellPrice}`);
      logit(`DEBUG: 磨损计算 - 磨损损失: ${stats.wearLoss}, 磨损比例: ${stats.wearLossPercentage}%`);
      
      logit(`📊 ${dateKey} 磨损统计: 买入${avgBuyPrice.toFixed(4)} USDT, 卖出${avgSellPrice.toFixed(4)} USDT, 磨损${stats.wearLoss.toFixed(4)} USDT (${stats.wearLossPercentage.toFixed(2)}%)`);
    } else {
      logit(`DEBUG: ${dateKey} 缺少买入或卖出交易，无法计算磨损`);
    }
  });
  
  return dailyStats;
}

/**
 * 检查当前页面是否包含非今日交易（用于判断是否停止翻页）
 * @returns {boolean} 如果包含非今日交易返回true，否则返回false
 */
function shouldStopPagination() {
  try {
    // 获取今日日期（考虑8点分界）
    const now = new Date();
    let today;
    if (now.getHours() < 8) {
      today = new Date(now);
      today.setDate(today.getDate() - 1);
    } else {
      today = new Date(now);
    }
    today.setHours(8, 0, 0, 0);
    const todayKey = today.toISOString().split('T')[0];
    
    // 获取当前页面的所有交易行
    let rows = document.querySelectorAll('.bn-web-table-tbody .bn-web-table-row:not(.bn-web-table-measure-row)');
    if (rows.length === 0) {
      rows = document.querySelectorAll('table tbody tr');
    }
    if (rows.length === 0) {
      rows = document.querySelectorAll('tbody tr');
    }
    
    // 检查每一行，如果发现非今日交易就停止翻页
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const cells = row.querySelectorAll('.bn-web-table-cell');
      
      if (cells.length >= 11) {
        // 获取时间（第2列，索引1）
        const timeText = cells[1]?.textContent?.trim();
        if (timeText) {
          const tradeDate = new Date(timeText);
          if (!isNaN(tradeDate.getTime())) {
            // 应用8点分界规则
            let adjustedDate = new Date(tradeDate);
            if (adjustedDate.getHours() < 8) {
              adjustedDate.setDate(adjustedDate.getDate() - 1);
            }
            adjustedDate.setHours(8, 0, 0, 0);
            const dateKey = adjustedDate.toISOString().split('T')[0];
            
            // 如果发现非今日交易，停止翻页
            if (dateKey !== todayKey) {
              logit(`发现非今日交易: ${timeText} -> ${dateKey}，停止翻页`);
              return true;
            }
          }
        }
      }
    }
    
    return false;
  } catch (error) {
    logit("检查是否停止翻页时出错:", error);
    return false;
  }
}

/**
 * 获取所有分页的交易数据
 * @returns {Array} 所有交易数据
 */
async function getAllTradesForVolumeCalc() {
  const allTrades = [];
  let pageCount = 0;
  const maxPages = 50; // 防止无限循环
  
  try {
    // 先获取第一页数据
    let currentPageTrades = getCurrentPageTradesForVolumeCalc();
    allTrades.push(...currentPageTrades);
    pageCount++;
    
    logit(`第 ${pageCount} 页: 获取到 ${currentPageTrades.length} 笔交易`);
    
    // 继续翻页获取数据
    while (hasNextPageForVolumeCalc() && pageCount < maxPages) {
      logit(`准备翻到第 ${pageCount + 1} 页...`);
      
      const hasNext = await clickNextPageForVolumeCalc();
      if (!hasNext) {
        logit("翻页失败，停止获取");
        break;
      }
      
      // 等待页面加载完成
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // 再次检查是否有下一页（防止页面加载后状态变化）
      if (!hasNextPageForVolumeCalc()) {
        logit("翻页后发现没有下一页，停止获取");
        break;
      }
      
      // 检查当前页面是否包含非今日交易，如果包含就停止翻页
      if (shouldStopPagination()) {
        logit(`第 ${pageCount + 1} 页包含非今日交易，停止翻页`);
        break;
      }
      
      currentPageTrades = getCurrentPageTradesForVolumeCalc();
      allTrades.push(...currentPageTrades);
      pageCount++;
      
      logit(`第 ${pageCount} 页: 获取到 ${currentPageTrades.length} 笔交易`);
      
      // 如果当前页没有数据，可能已经到最后一页
      if (currentPageTrades.length === 0) {
        logit("当前页没有数据，可能已到最后一页");
        break;
      }
      
      // 每翻几页后稍作停顿，避免被风控
      if (pageCount % 3 === 0) {
        logit("已翻3页，稍作停顿...");
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    
    logit(`总共获取了 ${pageCount} 页数据，共 ${allTrades.length} 笔交易订单`);
    
  } catch (error) {
    logit("获取所有交易数据失败:", error);
  }
  
  return allTrades;
}

/**
 * 计算并显示交易量统计
 */
async function calculateTradingVolume() {
  try {
    logit("开始计算交易量统计...");
    
    // 1. 点击委托历史标签页
    logit("DEBUG: 开始点击委托历史标签页...");
    const tabClicked = await clickOrderHistoryTabForVolumeCalc();
    if (!tabClicked) {
      const errorMsg = "无法访问委托历史页面";
      logit(errorMsg);
      alert(errorMsg);
      return;
    }
    
    // 检查页面DOM结构
    const tables = document.querySelectorAll('table');
    logit(`DEBUG: 找到 ${tables.length} 个表格`);
    
    // 检查表格内容
    tables.forEach((table, index) => {
      const rows = table.querySelectorAll('tr');
      const cells = table.querySelectorAll('td, th');
      logit(`DEBUG: 表格${index + 1} - 行数: ${rows.length}, 单元格数: ${cells.length}`);
    });
    
    // 2. 获取所有交易数据
    logit("DEBUG: 开始获取所有交易数据...");
    const allTrades = await getAllTradesForVolumeCalc();
    
    logit(`DEBUG: 总共获取到 ${allTrades.length} 笔交易`);
    
    if (allTrades.length === 0) {
      const errorMsg = "未找到任何交易订单";
      logit(errorMsg);
      alert(errorMsg);
      return;
    }
    
    // 输出所有交易的时间范围
    if (allTrades.length > 0) {
      const firstTrade = allTrades[0];
      const lastTrade = allTrades[allTrades.length - 1];
      logit(`DEBUG: 交易时间范围: ${lastTrade.rawTime} 至 ${firstTrade.rawTime}`);
      
      // 统计买入和卖出数量
      const buyCount = allTrades.filter(t => t.isBuy).length;
      const sellCount = allTrades.filter(t => t.isSell).length;
      logit(`DEBUG: 总买入交易: ${buyCount} 笔, 总卖出交易: ${sellCount} 笔`);
    }
    
    // 3. 计算每日交易量
    logit("DEBUG: 开始计算每日交易量...");
    const dailyStats = calculateDailyVolumeForVolumeCalc(allTrades);
    
    // 4. 输出统计结果到console
    console.log("=== 今日交易量统计结果 ===");
    
    // 获取今日日期
    const now = new Date();
    let today;
    if (now.getHours() < 8) {
      today = new Date(now);
      today.setDate(today.getDate() - 1);
    } else {
      today = new Date(now);
    }
    const todayKey = today.toISOString().split('T')[0];
    
    console.log(`统计日期: ${todayKey} (8点分界)`);
    console.log(`总成交订单数: ${allTrades.length}`);
    console.log(`今日买入订单数: ${Object.keys(dailyStats).length > 0 ? dailyStats[todayKey]?.buyTrades?.length || 0 : 0}`);
    console.log("");
    
    // 只显示今日的统计
    if (Object.keys(dailyStats).length > 0 && dailyStats[todayKey]) {
      const stats = dailyStats[todayKey];
      console.log(`今日 (${todayKey}) 统计:`);
      console.log(`  买入订单数: ${stats.buyTrades?.length || 0}`);
      console.log(`  买入总量: ${stats.totalBuyVolume?.toFixed(4) || '0.0000'} KOGE`);
      console.log(`  平均每笔: ${stats.buyTrades?.length > 0 ? (stats.totalBuyVolume / stats.buyTrades.length).toFixed(4) : '0.0000'} KOGE`);
      console.log("");
    } else {
      console.log(`今日 (${todayKey}) 暂无买入订单`);
      console.log("");
    }
    
    // 计算今日统计
    const todayTrades = Object.keys(dailyStats).length > 0 && dailyStats[todayKey] ? dailyStats[todayKey].trades : [];
    const todayBuyTrades = Object.keys(dailyStats).length > 0 && dailyStats[todayKey] ? dailyStats[todayKey].buyTrades : [];
    const todayTotalVolume = todayBuyTrades.reduce((sum, trade) => Math.round((sum + trade.volume) * 100000000) / 100000000, 0); // KOGE买入总量
    const todayTotalValue = todayBuyTrades.reduce((sum, trade) => Math.round((sum + trade.totalValue) * 100000000) / 100000000, 0); // USDT买入成交额总量
    const todayAvgVolume = todayBuyTrades.length > 0 ? Math.round((todayTotalVolume / todayBuyTrades.length) * 100000000) / 100000000 : 0; // 平均KOGE
    const todayAvgValue = todayBuyTrades.length > 0 ? Math.round((todayTotalValue / todayBuyTrades.length) * 100000000) / 100000000 : 0; // 平均每笔USDT成交额
    
    // 获取今日的买入卖出统计
    const todayStats = dailyStats[todayKey] || {};
    const todayBuyCount = todayStats.buyTrades ? todayStats.buyTrades.length : 0;
    const todaySellCount = todayStats.sellTrades ? todayStats.sellTrades.length : 0;
    const todayWearLoss = todayStats.wearLoss || 0;
    const todayWearLossPercentage = todayStats.wearLossPercentage || 0;
    const todayAvgBuyPrice = todayStats.totalBuyVolume > 0 ? Math.round((todayStats.totalBuyValue / todayStats.totalBuyVolume) * 100000000) / 100000000 : 0;
    const todayAvgSellPrice = todayStats.totalSellVolume > 0 ? Math.round((todayStats.totalSellValue / todayStats.totalSellVolume) * 100000000) / 100000000 : 0;
    
    console.log("=== 今日总体统计 ===");
    console.log(`今日买入总量: ${todayTotalVolume.toFixed(4)} KOGE`);
    console.log(`今日买入总额: ${todayTotalValue.toFixed(2)} USDT`);
    console.log(`今日平均每笔数量: ${todayAvgVolume.toFixed(4)} KOGE`);
    console.log(`今日平均每笔金额: ${todayAvgValue.toFixed(2)} USDT`);
    if (todayBuyTrades.length > 0) {
      console.log(`今日买入时间范围: ${todayBuyTrades[todayBuyTrades.length - 1]?.rawTime} 至 ${todayBuyTrades[0]?.rawTime}`);
    }
    
    // 输出磨损统计
    if (todayBuyCount > 0 && todaySellCount > 0) {
      console.log("=== 今日磨损统计 ===");
      console.log(`今日买入笔数: ${todayBuyCount} 笔`);
      console.log(`今日卖出笔数: ${todaySellCount} 笔`);
      console.log(`平均买入价格: ${todayAvgBuyPrice.toFixed(4)} USDT`);
      console.log(`平均卖出价格: ${todayAvgSellPrice.toFixed(4)} USDT`);
      console.log(`磨损损失: ${todayWearLoss.toFixed(4)} USDT`);
      console.log(`磨损百分比: ${todayWearLossPercentage.toFixed(2)}%`);
    }
    
    // 5. 创建并显示DOM界面
    createTradingStatsDisplay(
      todayKey, 
      todayTotalValue, // USDT买入成交额总量
      todayAvgValue, // 平均每笔USDT成交额
      todayWearLoss,
      todayWearLossPercentage
    );
    
    logit("交易量统计完成，请查看控制台输出和页面显示");
    
  } catch (error) {
    const errorMsg = `计算交易量统计失败: ${error.message}`;
    logit(errorMsg);
    console.error("交易量统计错误:", error);
    alert(errorMsg);
  }
}

/**
 * 创建交易统计显示界面
 * @param {string} date - 统计日期
 * @param {number} totalValue - 总成交额（USDT）
 * @param {number} avgValue - 平均每笔成交额（USDT）
 * @param {number} wearLoss - 磨损损失
 * @param {number} wearLossPercentage - 磨损百分比
 * @param {boolean} isCalculating - 是否正在计算中
 */
function createTradingStatsDisplay(date, totalValue, avgValue, wearLoss, wearLossPercentage, isCalculating = false) {
  try {
    // 移除已存在的统计界面
    const existingDisplay = document.getElementById('trading-stats-display');
    if (existingDisplay) {
      existingDisplay.remove();
    }
    
    // 创建主容器 - 黑白风格
    const displayContainer = document.createElement('div');
    displayContainer.id = 'trading-stats-display';
    displayContainer.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      width: 280px;
      background: #000000;
      border: 2px solid #ffffff;
      border-radius: 4px;
      padding: 12px;
      color: #ffffff;
      font-family: 'Courier New', 'Monaco', 'Menlo', monospace;
      font-size: 12px;
      line-height: 1.4;
      box-shadow: 0 0 20px rgba(255, 255, 255, 0.2);
      z-index: 10000;
      backdrop-filter: blur(5px);
    `;
    
    // 创建标题
    const title = document.createElement('div');
    title.textContent = `[TRADING STATS - ${date}]`;
    title.style.cssText = `
      margin: 0 0 8px 0;
      font-size: 11px;
      font-weight: bold;
      color: #ffffff;
      text-align: center;
      border-bottom: 1px solid #ffffff;
      padding-bottom: 4px;
      letter-spacing: 1px;
    `;
    
    // 创建统计内容
    const statsContainer = document.createElement('div');
    statsContainer.style.cssText = `
      display: flex;
      flex-direction: column;
      gap: 6px;
    `;
    
    if (isCalculating) {
      // 计算中状态
      const calculatingItem = createStatItem('STATUS:', 'CALCULATING...', '#ffff00');
      statsContainer.appendChild(calculatingItem);
    } else {
      // 1. 磨损损失
      const wearLossItem = createStatItem('WEAR_LOSS:', `${wearLoss.toFixed(4)} USDT`, wearLoss > 0 ? '#ff0000' : '#ffffff');
      
      // 2. 当日成交总额(买入)
      const totalValueItem = createStatItem('TOTAL_BUY:', `${totalValue.toFixed(2)} USDT`, '#ffffff');
      
      // 3. 四倍交易额
      const fourTimesValue = totalValue * 4;
      const fourTimesItem = createStatItem('4X_AMOUNT:', `${fourTimesValue.toFixed(2)} USDT`, '#cccccc');
      
      // 4. 平均每笔
      const avgValueItem = createStatItem('AVG_PER:', `${avgValue.toFixed(2)} USDT`, '#aaaaaa');
      
      // 添加到统计容器
      statsContainer.appendChild(wearLossItem);
      statsContainer.appendChild(totalValueItem);
      statsContainer.appendChild(fourTimesItem);
      statsContainer.appendChild(avgValueItem);
    }
    
    // 创建展开/隐藏按钮
    const toggleButton = document.createElement('button');
    toggleButton.textContent = '[HIDE]';
    toggleButton.style.cssText = `
      position: absolute;
      top: 4px;
      right: 4px;
      background: none;
      border: 1px solid #ffffff;
      color: #ffffff;
      font-family: 'Courier New', monospace;
      font-size: 10px;
      cursor: pointer;
      padding: 2px 4px;
      border-radius: 2px;
      transition: all 0.2s ease;
    `;
    
    // 创建刷新按钮
    const refreshButton = document.createElement('button');
    refreshButton.textContent = '[REFRESH]';
    refreshButton.style.cssText = `
      width: 100%;
      background: none;
      border: 1px solid #ffffff;
      color: #ffffff;
      padding: 4px;
      border-radius: 2px;
      font-family: 'Courier New', monospace;
      font-size: 10px;
      cursor: pointer;
      margin-top: 8px;
      transition: all 0.2s ease;
    `;
    
    // 展开/隐藏功能
    let isHidden = false;
    const originalHeight = 'auto';
    const hiddenHeight = '40px';
    
    toggleButton.onclick = () => {
      if (isHidden) {
        // 展开
        statsContainer.style.display = 'flex';
        refreshButton.style.display = 'block';
        displayContainer.style.height = originalHeight;
        displayContainer.style.overflow = 'visible';
        toggleButton.textContent = '[HIDE]';
        isHidden = false;
      } else {
        // 隐藏
        statsContainer.style.display = 'none';
        refreshButton.style.display = 'none';
        displayContainer.style.height = hiddenHeight;
        displayContainer.style.overflow = 'hidden';
        toggleButton.textContent = '[SHOW]';
        isHidden = true;
      }
    };
    
    // 按钮悬停效果
    toggleButton.onmouseover = () => {
      toggleButton.style.background = '#ffffff';
      toggleButton.style.color = '#000000';
    };
    toggleButton.onmouseout = () => {
      toggleButton.style.background = 'none';
      toggleButton.style.color = '#ffffff';
    };
    
    refreshButton.onmouseover = () => {
      refreshButton.style.background = '#ffffff';
      refreshButton.style.color = '#000000';
    };
    refreshButton.onmouseout = () => {
      refreshButton.style.background = 'none';
      refreshButton.style.color = '#ffffff';
    };
    refreshButton.onclick = () => {
      calculateTradingVolume();
    };
    
    // 组装界面
    displayContainer.appendChild(toggleButton);
    displayContainer.appendChild(title);
    displayContainer.appendChild(statsContainer);
    displayContainer.appendChild(refreshButton);
    
    // 添加到页面
    document.body.appendChild(displayContainer);
    
    // 添加动画效果
    displayContainer.style.opacity = '0';
    displayContainer.style.transform = 'translateY(20px)';
    setTimeout(() => {
      displayContainer.style.transition = 'all 0.3s ease';
      displayContainer.style.opacity = '1';
      displayContainer.style.transform = 'translateY(0)';
    }, 100);
    
    logit("交易统计界面已创建");
    
  } catch (error) {
    logit("创建交易统计界面失败:", error);
  }
}

/**
 * 创建统计项目
 * @param {string} label - 标签文本
 * @param {string} value - 数值文本
 * @param {string} color - 强调色
 * @returns {HTMLElement} 统计项目元素
 */
function createStatItem(label, value, color) {
  const item = document.createElement('div');
  item.style.cssText = `
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 4px 6px;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.3);
    border-radius: 2px;
    font-family: 'Courier New', monospace;
    font-size: 11px;
  `;
  
  const labelSpan = document.createElement('span');
  labelSpan.textContent = label;
  labelSpan.style.cssText = `
    font-size: 11px;
    color: #ffffff;
    font-weight: bold;
  `;
  
  const valueSpan = document.createElement('span');
  valueSpan.textContent = value;
  valueSpan.style.cssText = `
    font-size: 11px;
    font-weight: bold;
    color: ${color};
  `;
  
  item.appendChild(labelSpan);
  item.appendChild(valueSpan);
  
  return item;
}

// === 启动交易量计算 ===
// 先创建并展示悬浮窗口，显示"计算中"状态
createTradingStatsDisplay(
  new Date().toISOString().split('T')[0], 
  0, // 初始成交额
  0, // 初始平均每笔
  0, // 初始磨损损失
  0, // 初始磨损百分比
  true // 显示计算中状态
);

// 延迟一秒后开始计算，让用户看到窗口先出现
setTimeout(() => {
  calculateTradingVolume();
}, 1000);

// === 启动自动交易 ===
// startTrading();