/**
 * Binance Alpha Trading Bot
 * 
 * 使用说明:
 * 1. 打开浏览器，进入目标交易对页面 (例如: https://www.binance.com/zh-CN/alpha/bsc/0x92aa03137385f18539301349dcfc9ebc923ffb10)
 * 2. 打开开发者工具 (F12)，进入控制台 tab
 * 3. 配置以下参数:
 *    - slippage: 滑点百分比
 *    - buyAmountEachTime: 每次买入数量
 *    - retryOrderCheckMaxCount: 交易未完成时的重试次数
 *    - loopCount: 交易循环次数
 * 4. 复制修改后的代码到控制台中并运行
 */

// 交易配置参数
let slippage = '0.1'        // 滑点百分比
let buyAmountEachTime = 520  // 每次买入数量
let retryOrderCheckMaxCount = 10  // 交易未完成时的重试次数
let loopCount = 20          // 交易循环次数

// 延迟5秒后启动交易
setTimeout(() => {
  launch().catch(e => console.error(e));
}, 5000);

// 5分钟后自动刷新页面
setTimeout(() => {
  location.reload();
}, 300000);

/**
 * 自定义日志函数，添加时间戳和前缀
 * @param {...any} args - 要打印的参数
 */
logit = function() {
  const args = Array.from(arguments);
  const timestamp = new Date().toISOString();
  const prefix = `BNAlpha - ${timestamp}:`;
  
  if (args.length > 0) {
    if (typeof args[0] === 'string') {
      args[0] = `${prefix} ${args[0]}`;
    } else {
      args.unshift(prefix);
    }
  } else {
    args.push(prefix);
  }
  
  console.log.apply(console, args);
};

/**
 * 设置输入框的值并触发相应事件
 * @param {HTMLElement} inputElement - 目标输入框元素
 * @param {string|number} value - 要设置的值
 */
function setInputValue(inputElement, value) {
  if (!inputElement) return;
  inputElement.focus();
  // 先清空，再插入
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  nativeInputValueSetter.call(inputElement, '');
  nativeInputValueSetter.call(inputElement, value);
  inputElement.dispatchEvent(new Event('input', { bubbles: true }));
  inputElement.dispatchEvent(new Event('change', { bubbles: true }));
  inputElement.blur();
}

/**
 * 等待元素出现并返回
 * @param {string|Function} selector - CSS选择器或返回元素的函数
 * @param {Function|null} checker - 可选的元素检查函数
 * @param {number} maxAttempts - 最大尝试次数
 * @param {number} interval - 重试间隔(毫秒)
 * @param {number} initialDelay - 初始延迟(毫秒)
 * @returns {Promise<HTMLElement>}
 */
function waitForElement(selector, checker = null, maxAttempts = 10, interval = 2000, initialDelay = 1000) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      let attempts = 0;
      function attempt() {
        const el = typeof selector === 'string' ? document.querySelector(selector) : selector();
        if (el && (!checker || checker(el))) {
          resolve(el);
        } else {
          attempts++;
          if (attempts < maxAttempts) {
            setTimeout(attempt, interval);
          } else {
            reject(new Error('元素未找到: ' + selector));
          }
        }
      }
      attempt();
    }, initialDelay);
  });
}

/**
 * 点击优先模式按钮
 * @returns {Promise<void>}
 */
async function clickPriorityMode() {
  // 查找优先模式元素的第一个邻居的第一个子元素
  return waitForElement(
    () => {
      const priorityModeText = Array.from(document.querySelectorAll('.t-caption1')).find(
        el => el.textContent === '优先模式'
      );
      if (priorityModeText) {
        const firstSibling = priorityModeText.nextElementSibling;
        if (firstSibling && firstSibling.firstElementChild) {
          return firstSibling.firstElementChild;
        }
      }
      return null;
    },
    null, 10, 2000
  ).then(el => {
    el.click();
    logit('已点击优先模式的第一个邻居元素的第一个子元素');
  });
}

/**
 * 点击自定义滑点选项
 * @returns {Promise<void>}
 */
async function clickCustomElement() {
  // 查找并点击包含"自定义"文本的特定元素
  return waitForElement(
    () => {
      const elements = document.querySelectorAll('.p-\\[16px\\].rounded-\\[12px\\].border.border-solid.border-InputLine');
      return Array.from(elements).find(el => el.textContent.includes('自定义'));
    },
    null, 10, 2000
  ).then(el => {
    el.click();
    logit('已点击包含\"自定义\"的目标元素');
  });
}

/**
 * 设置自定义滑点值
 * @param {string} customSlippage - 滑点值
 * @returns {Promise<void>}
 */
async function setCustomSlippage(customSlippage) {
  // 查找并设置自定义滑点值为0.1
  return waitForElement(
    '#customize-slippage',
    null, 10, 2000
  ).then(el => {
    setInputValue(el, customSlippage);
    logit(`已设置自定义滑点值为 ${customSlippage}`);
  });
}

/**
 * 点击模态框确认按钮
 * @returns {Promise<void>}
 */
async function clickModalConfirmButton() {
  // 点击 .bn-modal-footer 下的带有「确认」文字的按钮
  return waitForElement(
    () => {
      const footers = document.querySelectorAll('.bn-modal-footer');
      for (const footer of footers) {
        const buttons = footer.querySelectorAll('button');
        for (const button of buttons) {
          if (button.textContent.includes('确认') && !button.disabled) {
            return button;
          }
        }
      }
      return null;
    },
    null, 10, 2000, 1000
  ).then(el => {
    el.click();
    logit('已点击确认按钮');
  });
}

/**
 * 确认下单
 * @param {string} direction - 交易方向 ('buy' 或 'sell')
 * @returns {Promise<void>}
 */
async function confirmOrderPlace(direction) {
  // 点击购买
  return waitForElement(
    () => {
      const buttons = document.querySelectorAll(".bn-button.bn-button__" + direction);
      for (const button of buttons) {
        if (!button.disabled) {
          return button;
        }
      }
      return null;
    },
    null, 10, 2000, 3000
  ).then(el => {
    el.click();
    logit('已点击下单按钮');
  });
}

/**
 * 打开订单历史页面
 * @returns {Promise<void>}
 */
async function openOrderHistory() {
  // 点击 data-tab-key="orderHistory"
  return waitForElement(
    () => {
      const tab = document.querySelector('[data-tab-key="orderHistory"]');
      return tab;
    },
  ).then(el => {
    el.click();
    logit('已点击订单历史');
  });
}

/**
 * 检查最近订单状态
 * @param {string} direction - 交易方向
 * @returns {Promise<boolean>} - 订单是否完成
 */
async function checkRecentOrderStatus(direction) {
  // TODO: Should Check with order related to the current order
  // 等待表格加载
      const rows = document.querySelectorAll('.bn-web-table-row');
      if (rows.length < 1) return null;
      
      // 获取第一行交易（index=1）
      const firstRow = rows[0];
      if (!firstRow) return null;

      // 获取交易方向
      const directionCell = firstRow.querySelector('[aria-colindex="3"] div');
      if (!directionCell) return null;
      
      // 获取交易状态
      const statusCell = firstRow.querySelector('[aria-colindex="6"] div');
      logit('statusCell', statusCell);
      if (!statusCell) return null;

      // 检查方向是否匹配
      const isDirectionMatch = directionCell.textContent === direction;
      // 检查状态是否为"已完成"
      const isCompleted = statusCell.textContent === '已完成';
      return isDirectionMatch && isCompleted;
}

/**
 * 切换到买入或卖出标签
 * @param {string} direction - 交易方向 ('买入' 或 '卖出')
 * @returns {Promise<void>}
 */
async function switchToBuyOrSell(direction) {
  // 根据交易方向切换到买入或卖入标签
  return waitForElement(
    () => {
      // 查找带有 bn-tab__buySell 样式的标签
      const tabs = document.querySelectorAll('.bn-tab__buySell');
      if (!tabs || tabs.length < 2) return null;

      return Array.from(tabs).find(tab => tab.textContent.includes(direction))
    }
  ).then(el => {
    el.click();
    logit(`已切换到${direction}标签`);
  });
}

/**
 * 主函数：执行交易循环
 * @returns {Promise<void>}
 */
async function launch() {
  await openOrderHistory()
  // 清空一次订单
  await placeTillSuccess(launchSell, '卖出', 0);
  for (let i = 0; i < loopCount; i++) {
    await placeTillSuccess(launchBuy, '买入');
    await placeTillSuccess(launchSell, '卖出');
    logit('第' + (i + 1) + '次交易完成，预计交易额' + (buyAmountEachTime * (i + 1)));
  }
}

async function waitForOrderProcessingCompletion() {
  logit('等待订单处理完成...');
  return new Promise((resolve) => {
    const checkInterval = setInterval(() => {
      const orderTab = document.querySelector('#bn-tab-orderOrder');
      if (orderTab && orderTab.textContent === '处理中(0)') { 
        logit('订单处理已完成: 处理中(0)');
        clearInterval(checkInterval);
        resolve();
      } else {
        const currentStatus = orderTab ? orderTab.textContent : '未找到元素';
        logit(`订单处理中: ${currentStatus}`);
      }
    }, 1000); // 每秒检查一次
    
    // 设置超时，防止无限等待
    setTimeout(() => {
      clearInterval(checkInterval);
      logit('等待订单处理完成超时，继续执行');
      resolve();
    }, 30000); // 30秒超时
  });
}

/**
 * 执行交易直到成功或达到最大重试次数
 * @param {Function} operationFunction - 交易操作函数
 * @param {string} direction - 交易方向
 * @param {number} maxRetryCount - 最大重试次数
 * @returns {Promise<void>}
 */
async function placeTillSuccess(operationFunction, direction, maxRetryCount = retryOrderCheckMaxCount) {
  await operationFunction();
  
  await waitForOrderProcessingCompletion();
  

  let retryCount = 0;
  while (true) {
    const orderStatus = await checkRecentOrderStatus(direction);
    logit('orderStatus', orderStatus);
    if (orderStatus) {
      logit('交易已完成');
      break;
    }
    
    // 增加重试间隔，每次重试等待3秒
    logit(`交易未完成，等待3秒后继续下单 (${retryCount + 1}/${maxRetryCount})`);
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    await operationFunction();
    await waitForOrderProcessingCompletion();

    
    retryCount++;
    if (retryCount >= maxRetryCount) {
      logit(`交易未完成，超过${maxRetryCount}次，重新加载页面`);
      break;
    }
  }
}

/**
 * 执行买入操作
 * @returns {Promise<void>}
 */
async function launchBuy() {
  await switchToBuyOrSell('买入');

  setInputValue(document.querySelector('#fromCoinAmount'), buyAmountEachTime)
  await clickPriorityMode();
  await clickCustomElement();
  await setCustomSlippage(slippage);
  await clickModalConfirmButton();
  await confirmOrderPlace('buy');
  await clickModalConfirmButton();
}

/**
 * 执行卖出操作
 * @returns {Promise<void>}
 */
async function launchSell() {
  await switchToBuyOrSell('卖出');

  setInputValue(document.querySelector('input[role="slider"]'), 100)
  if (document.querySelector('input[role="slider"]').value === '0') {
    logit('卖出失败，无存货');
    return;
  }
  await clickPriorityMode();
  await clickCustomElement();
  await setCustomSlippage(slippage);
  await clickModalConfirmButton();
  await confirmOrderPlace('sell');
  await clickModalConfirmButton();
}

// 启动交易程序
await launch()
