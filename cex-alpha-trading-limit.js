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
 *   3. 快速加载命令（在浏览器console中运行）：
 *      fetch('https://raw.githubusercontent.com/oif/bn-alpha-kit/refs/heads/main/cex-alpha-trading-limit.js').then(r=>r.text()).then(eval)
 *   4. 使用悬浮控制面板调整参数并开始交易
 *
 * 主要参数说明：
 *   ORDER_PRICE_BUY         —— 买入价格（固定价格模式）
 *   ORDER_PRICE_SELL        —— 卖出价格（固定价格模式）
 *   ENABLE_DYNAMIC_PRICING  —— 是否启用动态价格设定（true/false）
 *   PRICE_OFFSET            —— 动态价格偏移量（买入价格 = 分布最多价格 + 偏移量，卖出价格 = 分布最多价格 - 偏移量）
 *   定价可以放在 K 线核心波动范围内，必要时候可以考虑卖出高于买入，价格建议参考手机客户端限价交易页面的实时成交记录设定。
 *   启用动态价格时，每轮交易前会自动从成交记录中分析价格分布，找到出现次数最多的价格作为基准，实现最小磨损。
 *   ORDER_VOLUME            —— 每次买/卖的数量
 *   MAX_TRADES              —— 预设买卖轮数
 *   ORDER_TIMEOUT_MS        —— 单笔订单最大等待成交时间（毫秒），如果是希望低磨损，慢慢等待合适价格买卖的话，推荐这个值给到分钟级以上
 *   ABORT_ON_PRICE_WARNING  —— 遇到价格警告弹窗时是否中止（true/false）
 *
 * 功能特性：
 *   - 悬浮控制面板：实时调整参数，无需修改代码
 *   - 动态价格计算：自动分析价格分布，最小化磨损
 *   - 实时统计显示：交易量、磨损率等数据实时更新
 *   - 智能等待机制：基于DOM状态等待，提高成功率
 *   - 分页数据获取：自动翻页获取完整交易历史
 *   - 错误处理机制：完善的异常处理和日志记录
 *
 * 注意事项：
 *   - 本脚本仅供学习与研究自动化技术使用，严禁用于违反交易所规则的行为。
 *   - 频繁交易可能导致账号风控、冻结等风险，请谨慎使用。
 *   - 交易期间建议偶尔移动鼠标或进行简单页面交互，以减少被风控系统判定为异常行为的风险。
 *   - 交易所 UI 可能更新，请根据实际页面结构调整选择器。
 *   - 建议在测试账号或模拟盘环境下使用。
 *   - DYOR！！！
 *
 * 版本：2.0.0
 * 更新时间：2024-12-19
 * GitHub: https://github.com/oif/bn-alpha-kit
 * MIT License
 */

// === 全局参数配置 ===
/** 买入价格（建议略低于市价，单位：币种） */
let ORDER_PRICE_BUY = 48.004839;
/** 卖出价格（建议略高于市价，单位：币种） */
let ORDER_PRICE_SELL = 48.0048361;
/** 每次买/卖的数量（单位：币种） */
let ORDER_VOLUME = 10;
/** 最大交易轮数（即买入+卖出为一轮） */
let MAX_TRADES = 13;
/** 单笔订单最大等待成交时间（毫秒），超时未成交则提示人工干预。*/
let ORDER_TIMEOUT_MS = 300000;
/** 遇到价格警告弹窗时是否中止（true/false） */
let ABORT_ON_PRICE_WARNING = false;
/** 是否启用动态价格设定（true/false） */
let ENABLE_DYNAMIC_PRICING = true;
/** 动态价格偏移量（买入价格 = 分布最多价格 + 偏移量，卖出价格 = 分布最多价格 - 偏移量） */
/** 如果给 0 则代表在分布价格上不加价也不减价，但可能会出手比较慢 */
let PRICE_OFFSET = 0.00000000;
/** 24 小时成交量最低要求（单位：M）不推荐刷成交量太低的币，潜在大波动 */
let MIN_VOLUME_M = 500;

// === 悬浮控制面板 ===
let controlPanel = null;
let isTrading = false;
let currentDynamicPrices = { buyPrice: 0, sellPrice: 0 };
let completedTrades = 0; // 跟踪已完成的交易轮数
let paginationDebugInfo = ''; // 分页调试信息

/**
 * 创建悬浮控制面板
 */
function createControlPanel() {
  // 移除已存在的控制面板
  if (controlPanel) {
    controlPanel.remove();
  }

  // 创建主容器
  controlPanel = document.createElement('div');
  controlPanel.id = 'alpha-trading-control-panel';
  controlPanel.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    width: 580px;
    background: #000000;
    border: 2px solid #ffffff;
    border-radius: 0px;
    padding: 8px;
    color: #ffffff;
    font-family: 'Courier New', 'Monaco', 'Menlo', monospace;
    font-size: 11px;
    line-height: 1.2;
    box-shadow: 0 0 20px rgba(255, 255, 255, 0.3);
    z-index: 10001;
    transition: all 0.2s ease;
    max-height: 80vh;
    overflow-y: auto;
  `;

  // 创建标题栏
  const titleBar = document.createElement('div');
  titleBar.style.cssText = `
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
    padding-bottom: 4px;
    border-bottom: 1px solid #ffffff;
  `;

  const title = document.createElement('div');
  title.textContent = '[ ALPHA TRADING CONTROL ]';
  title.style.cssText = `
    font-weight: bold;
    font-size: 12px;
    color: #ffffff;
    text-align: center;
    letter-spacing: 1px;
  `;

  // 控制按钮容器
  const controlButtons = document.createElement('div');
  controlButtons.style.cssText = `
    display: flex;
    gap: 2px;
  `;

  // 缩小按钮
  const minimizeBtn = document.createElement('button');
  minimizeBtn.textContent = '[_]';
  minimizeBtn.style.cssText = `
    background: none;
    border: 1px solid #ffffff;
    color: #ffffff;
    font-family: 'Courier New', monospace;
    font-size: 10px;
    cursor: pointer;
    padding: 2px 4px;
    transition: all 0.2s ease;
  `;
  minimizeBtn.onmouseover = () => {
    minimizeBtn.style.background = '#ffffff';
    minimizeBtn.style.color = '#000';
  };
  minimizeBtn.onmouseout = () => {
    minimizeBtn.style.background = 'none';
    minimizeBtn.style.color = '#ffffff';
  };
  minimizeBtn.onclick = () => {
    const gridContainer = controlPanel.querySelector('.grid-container');
    if (gridContainer) {
      gridContainer.style.display = gridContainer.style.display === 'none' ? 'grid' : 'none';
      minimizeBtn.textContent = gridContainer.style.display === 'none' ? '[□]' : '[_]';
    }
  };

  // 关闭按钮
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '[X]';
  closeBtn.style.cssText = `
    background: none;
    border: 1px solid #ffffff;
    color: #ffffff;
    font-family: 'Courier New', monospace;
    font-size: 10px;
    cursor: pointer;
    padding: 2px 4px;
    transition: all 0.2s ease;
  `;
  closeBtn.onmouseover = () => {
    closeBtn.style.background = '#ffffff';
    closeBtn.style.color = '#000';
  };
  closeBtn.onmouseout = () => {
    closeBtn.style.background = 'none';
    closeBtn.style.color = '#ffffff';
  };
  closeBtn.onclick = () => {
    controlPanel.remove();
    controlPanel = null;
  };

  controlButtons.appendChild(minimizeBtn);
  controlButtons.appendChild(closeBtn);
  titleBar.appendChild(title);
  titleBar.appendChild(controlButtons);

  // 创建参数配置区域
  const configSection = document.createElement('div');
  configSection.style.cssText = `
    margin-bottom: 16px;
  `;

  // 价格配置
  const priceSection = createParameterSection('PRICE CONFIG', [
    { label: 'DYNAMIC PRICE', value: ENABLE_DYNAMIC_PRICING, key: 'ENABLE_DYNAMIC_PRICING', type: 'checkbox', description: '自动从市场获取最优价格' },
    { label: 'PRICE OFFSET', value: PRICE_OFFSET, key: 'PRICE_OFFSET', type: 'number', step: '0.00000001', description: '买入价格=市场价+偏移量，卖出价格=市场价-偏移量' },
    { label: 'BUY PRICE', value: ORDER_PRICE_BUY, key: 'ORDER_PRICE_BUY', type: 'number', step: '0.000001', disabled: ENABLE_DYNAMIC_PRICING, description: '固定买入价格（动态价格关闭时使用）' },
    { label: 'SELL PRICE', value: ORDER_PRICE_SELL, key: 'ORDER_PRICE_SELL', type: 'number', step: '0.000001', disabled: ENABLE_DYNAMIC_PRICING, description: '固定卖出价格（动态价格关闭时使用）' }
  ]);

  // 交易配置
  const tradeSection = createParameterSection('TRADE CONFIG', [
    { label: 'VOLUME', value: ORDER_VOLUME, key: 'ORDER_VOLUME', type: 'number', step: '0.000001', description: '每次交易的 USDT 数量' },
    { label: 'MAX TRADES', value: MAX_TRADES, key: 'MAX_TRADES', type: 'number', step: '1', description: '预设买卖轮数' },
    { label: 'TIMEOUT(SEC)', value: ORDER_TIMEOUT_MS / 1000, key: 'ORDER_TIMEOUT_MS', type: 'number', step: '1', transform: (val) => val * 1000, description: '订单超时时间（秒）' }
  ]);

  // 其他配置
  const otherSection = createParameterSection('OTHER CONFIG', [
    { label: 'MIN VOLUME(M)', value: MIN_VOLUME_M, key: 'MIN_VOLUME_M', type: 'number', step: '1', description: '代币市值低于此值不交易' }
  ]);

  // 开关配置
  // const switchSection = createSwitchSection('FUNCTION SWITCH', [
  //   { label: 'PRICE WARNING ABORT', value: ABORT_ON_PRICE_WARNING, key: 'ABORT_ON_PRICE_WARNING', description: '遇到价格警告弹窗时停止交易' }
  // ]);

  // 控制按钮
  const buttonSection = createButtonSection();

  // 动态价格显示区域
  const dynamicPriceSection = createDynamicPriceSection();

  // 交易统计区域
  const statsSection = createStatsSection();

  // 分页调试区域
  const paginationDebugSection = createPaginationDebugSection();

  // 创建网格容器
  const gridContainer = document.createElement('div');
  gridContainer.className = 'grid-container';
  gridContainer.style.cssText = `
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 4px;
    margin-top: 4px;
  `;

  // 组装界面
  controlPanel.appendChild(titleBar);
  
  // 左列 - 价格配置
  const leftColumn = document.createElement('div');
  leftColumn.style.cssText = `
    display: flex;
    flex-direction: column;
    gap: 4px;
  `;
  leftColumn.appendChild(priceSection);
  
  // 中列 - 交易配置和其他配置
  const middleColumn = document.createElement('div');
  middleColumn.style.cssText = `
    display: flex;
    flex-direction: column;
    gap: 4px;
  `;
  middleColumn.appendChild(tradeSection);
  middleColumn.appendChild(otherSection);
  // middleColumn.appendChild(switchSection);
  
  // 右列 - 控制和统计
  const rightColumn = document.createElement('div');
  rightColumn.style.cssText = `
    display: flex;
    flex-direction: column;
    gap: 4px;
  `;
  rightColumn.appendChild(buttonSection);
  rightColumn.appendChild(dynamicPriceSection);
  rightColumn.appendChild(statsSection);
  rightColumn.appendChild(paginationDebugSection);
  
  gridContainer.appendChild(leftColumn);
  gridContainer.appendChild(middleColumn);
  gridContainer.appendChild(rightColumn);
  controlPanel.appendChild(gridContainer);

  // 添加到页面
  document.body.appendChild(controlPanel);

  // 添加动画效果
  controlPanel.style.opacity = '0';
  controlPanel.style.transform = 'translateX(20px)';
  setTimeout(() => {
    controlPanel.style.opacity = '1';
    controlPanel.style.transform = 'translateX(0)';
  }, 100);

  // 初始化动态价格显示
  if (ENABLE_DYNAMIC_PRICING) {
    const section = document.getElementById('dynamic-price-section');
    if (section) {
      section.style.display = 'block';
    }
  }

  logit('悬浮控制面板已创建');
  
  // 添加全局测试函数
  window.testPagination = async function() {
    logit("开始测试分页功能...");
    debugPaginationStatus();
    updatePaginationDebugDisplay();
    
    if (hasNextPageForVolumeCalc()) {
      logit("找到下一页，尝试翻页...");
      const result = await clickNextPageForVolumeCalc();
      logit(`翻页结果: ${result}`);
      
      // 等待并检查结果
      setTimeout(() => {
        debugPaginationStatus();
        updatePaginationDebugDisplay();
      }, 3000);
    } else {
      logit("没有下一页了");
    }
  };
  
  logit('已添加全局测试函数: testPagination()');
  
  // 添加表格解析测试函数
  window.testTableParsing = function() {
    logit("开始测试表格解析...");
    
    // 先显示所有行的信息
    const allRows = document.querySelectorAll('.bn-web-table-tbody tr, table tbody tr, tbody tr');
    logit(`总共找到 ${allRows.length} 行（包括测量行）`);
    
    allRows.forEach((row, index) => {
      const isMeasureRow = row.classList.contains('bn-web-table-measure-row') || row.getAttribute('aria-hidden') === 'true';
      const rowType = isMeasureRow ? '测量行' : '数据行';
      logit(`行${index + 1}: ${rowType} - aria-hidden="${row.getAttribute('aria-hidden')}" - class="${row.className}"`);
    });
    
    // 查找表格行，排除测量行
    let rows = document.querySelectorAll('.bn-web-table-tbody .bn-web-table-row:not(.bn-web-table-measure-row)');
    if (rows.length === 0) {
      rows = document.querySelectorAll('table tbody tr:not(.bn-web-table-measure-row)');
    }
    if (rows.length === 0) {
      rows = document.querySelectorAll('tbody tr:not(.bn-web-table-measure-row)');
    }
    
    logit(`找到 ${rows.length} 行数据（已排除测量行）`);
    
    if (rows.length > 0) {
      // 测试解析第一行
      const firstRow = rows[0];
      logit("测试解析第一行:");
      
      // 先显示第一行的所有单元格内容
      const cells = firstRow.querySelectorAll('.bn-web-table-cell');
      logit(`第一行有 ${cells.length} 个单元格`);
      cells.forEach((cell, index) => {
        const text = cell.textContent?.trim() || '';
        logit(`单元格${index + 1}: "${text}"`);
      });
      
      const result = parseTradeRowForVolumeCalc(firstRow);
      
      if (result) {
        logit("解析成功:", result);
      } else {
        logit("解析失败");
      }
    } else {
      logit("没有找到有效的数据行");
    }
  };
  
  logit('已添加全局测试函数: testTableParsing()');
}

/**
 * 创建参数配置区域
 */
function createParameterSection(title, parameters) {
  const section = document.createElement('div');
  section.style.cssText = `
    margin-bottom: 2px;
    padding: 3px;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid #ffffff;
  `;

  const sectionTitle = document.createElement('div');
  sectionTitle.textContent = `[ ${title} ]`;
  sectionTitle.style.cssText = `
    font-weight: bold;
    margin-bottom: 3px;
    color: #ffffff;
    font-size: 10px;
    text-align: center;
    letter-spacing: 1px;
  `;

  section.appendChild(sectionTitle);

  parameters.forEach(param => {
    // 参数行容器
    const paramContainer = document.createElement('div');
    paramContainer.style.cssText = `
      margin-bottom: 3px;
      padding: 2px;
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid rgba(255, 255, 255, 0.2);
    `;

    // 参数行
    const paramRow = document.createElement('div');
    paramRow.style.cssText = `
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1px;
    `;

    const label = document.createElement('label');
    label.textContent = param.label;
    label.style.cssText = `
      font-size: 10px;
      color: #ffffff;
              min-width: 80px;
      font-family: 'Courier New', monospace;
      font-weight: bold;
    `;

    // 创建输入控件
    let input;
    if (param.type === 'checkbox') {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = param.value;
      input.style.cssText = `
        width: 14px;
        height: 14px;
        accent-color: #ffffff;
      `;
    } else {
      input = document.createElement('input');
      input.type = param.type;
      input.value = param.value;
      input.step = param.step;
      input.disabled = param.disabled || false;
      input.style.cssText = `
        width: 90px;
        padding: 2px 4px;
        border: 1px solid #ffffff;
        background: ${param.disabled ? '#333' : '#000'};
        color: ${param.disabled ? '#666' : '#ffffff'};
        font-size: 10px;
        text-align: right;
        font-family: 'Courier New', monospace;
      `;
    }

    input.setAttribute('data-key', param.key);

    // 事件处理
    if (param.type === 'checkbox') {
      input.onchange = () => {
        window[param.key] = input.checked;
        logit(`${param.label} 已${input.checked ? '启用' : '禁用'}`);
        
        // 如果是动态价格开关，需要更新价格输入框状态
        if (param.key === 'ENABLE_DYNAMIC_PRICING') {
          updatePriceInputsState(input.checked);
          if (input.checked) {
            // 显示动态价格区域
            const section = document.getElementById('dynamic-price-section');
            if (section) {
              section.style.display = 'block';
            }
          } else {
            // 隐藏动态价格区域
            hideDynamicPriceDisplay();
          }
        }
      };
    } else {
      input.onchange = () => {
        let value = param.type === 'number' ? parseFloat(input.value) : input.value;
        if (param.transform) {
          value = param.transform(value);
        }
        
        // 直接更新全局变量
        if (param.key === 'ORDER_VOLUME') {
          ORDER_VOLUME = value;
        } else if (param.key === 'MAX_TRADES') {
          MAX_TRADES = value;
        } else if (param.key === 'ORDER_TIMEOUT_MS') {
          ORDER_TIMEOUT_MS = value;
        } else if (param.key === 'MIN_VOLUME_M') {
          MIN_VOLUME_M = value;
        } else if (param.key === 'ORDER_PRICE_BUY') {
          ORDER_PRICE_BUY = value;
        } else if (param.key === 'ORDER_PRICE_SELL') {
          ORDER_PRICE_SELL = value;
        } else if (param.key === 'PRICE_OFFSET') {
          PRICE_OFFSET = value;
        } else {
          window[param.key] = value;
        }
        
        // 特殊处理某些参数的更新
        if (param.key === 'MAX_TRADES') {
          // 更新循环次数显示
          const currentCompleted = isTrading ? completedTrades : 0; // 如果正在交易，保持当前进度
          updateCycleDisplay(currentCompleted, value);
        }
        
        logit(`${param.label} 已更新为: ${value}`);
      };
    }

    paramRow.appendChild(label);
    paramRow.appendChild(input);
    paramContainer.appendChild(paramRow);

    // 添加说明文字
    if (param.description) {
      const description = document.createElement('div');
      description.textContent = `  ${param.description}`;
      description.style.cssText = `
        font-size: 10px;
        color: #cccccc;
        font-family: 'Courier New', monospace;
        line-height: 1.2;
        margin-top: 2px;
      `;
      paramContainer.appendChild(description);
    }

    section.appendChild(paramContainer);
  });

  return section;
}

/**
 * 更新价格输入框状态
 */
function updatePriceInputsState(isDynamicEnabled) {
  const buyPriceInput = document.querySelector('input[data-key="ORDER_PRICE_BUY"]');
  const sellPriceInput = document.querySelector('input[data-key="ORDER_PRICE_SELL"]');
  
  if (buyPriceInput) {
    buyPriceInput.disabled = isDynamicEnabled;
    buyPriceInput.style.background = isDynamicEnabled ? '#333' : '#000';
    buyPriceInput.style.color = isDynamicEnabled ? '#666' : '#00ff00';
  }
  
  if (sellPriceInput) {
    sellPriceInput.disabled = isDynamicEnabled;
    sellPriceInput.style.background = isDynamicEnabled ? '#333' : '#000';
    sellPriceInput.style.color = isDynamicEnabled ? '#666' : '#00ff00';
  }
}

/**
 * 创建开关配置区域
 */
function createSwitchSection(title, switches) {
  const section = document.createElement('div');
  section.style.cssText = `
    margin-bottom: 2px;
    padding: 3px;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid #ffffff;
  `;

  const sectionTitle = document.createElement('div');
  sectionTitle.textContent = `[ ${title} ]`;
  sectionTitle.style.cssText = `
    font-weight: bold;
    margin-bottom: 3px;
    color: #ffffff;
    font-size: 10px;
    text-align: center;
    letter-spacing: 1px;
  `;

  section.appendChild(sectionTitle);

  switches.forEach(sw => {
    // 开关容器
    const switchContainer = document.createElement('div');
    switchContainer.style.cssText = `
      margin-bottom: 3px;
      padding: 2px;
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid rgba(255, 255, 255, 0.2);
    `;

    const switchRow = document.createElement('div');
    switchRow.style.cssText = `
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1px;
    `;

    const label = document.createElement('label');
    label.textContent = sw.label;
    label.style.cssText = `
      font-size: 10px;
      color: #ffffff;
      font-family: 'Courier New', monospace;
      font-weight: bold;
    `;

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = sw.value;
    toggle.setAttribute('data-key', sw.key);
    toggle.style.cssText = `
      width: 14px;
      height: 14px;
      accent-color: #ffffff;
    `;

    toggle.onchange = () => {
      window[sw.key] = toggle.checked;
      logit(`${sw.label} 已${toggle.checked ? '启用' : '禁用'}`);
    };

    switchRow.appendChild(label);
    switchRow.appendChild(toggle);
    switchContainer.appendChild(switchRow);

    // 添加说明文字
    if (sw.description) {
      const description = document.createElement('div');
      description.textContent = `  ${sw.description}`;
      description.style.cssText = `
        font-size: 10px;
        color: #cccccc;
        font-family: 'Courier New', monospace;
        line-height: 1.2;
        margin-top: 2px;
      `;
      switchContainer.appendChild(description);
    }

    section.appendChild(switchContainer);
  });

  return section;
}

/**
 * 创建控制按钮区域
 */
function createButtonSection() {
  const section = document.createElement('div');
  section.style.cssText = `
    display: flex;
    gap: 2px;
    margin-top: 2px;
  `;

    // 合并的开始/停止交易按钮
  const tradeBtn = document.createElement('button');
  tradeBtn.textContent = '[START]';
  tradeBtn.style.cssText = `
    flex: 1;
    padding: 4px 6px;
    background: #000;
    color: #ffffff;
    border: 1px solid #ffffff;
    font-family: 'Courier New', monospace;
    font-size: 10px;
    font-weight: bold;
    cursor: pointer;
    transition: all 0.2s ease;
  `;

  tradeBtn.onmouseover = () => {
    if (!isTrading) {
      tradeBtn.style.background = '#ffffff';
      tradeBtn.style.color = '#000';
    }
  };
  tradeBtn.onmouseout = () => {
    if (!isTrading) {
      tradeBtn.style.background = '#000';
      tradeBtn.style.color = '#ffffff';
    }
  };

  tradeBtn.onclick = async () => {
    if (!isTrading) {
      // 开始交易
      isTrading = true;
      tradeBtn.textContent = '[STOP]';
      tradeBtn.style.background = '#ff6666';
      tradeBtn.style.color = '#ffffff';
      tradeBtn.style.border = '1px solid #ff6666';
      logit('开始自动交易...');
      
      // 重置循环次数显示
      completedTrades = 0;
      updateCycleDisplay(0, MAX_TRADES);
      
      // 交易开始前先计算一次统计
      logit('交易开始前计算初始统计数据...');
      await calculateTradingVolumeForPanel();
      
      startTrading().finally(() => {
        isTrading = false;
        tradeBtn.textContent = '[START]';
        tradeBtn.style.background = '#000';
        tradeBtn.style.color = '#ffffff';
        tradeBtn.style.border = '1px solid #ffffff';
        tradeBtn.disabled = false;
      });
    } else {
      // 停止交易
      stopTrading = true;
      isTrading = false;
      tradeBtn.textContent = '[STOPPING]';
      tradeBtn.style.background = '#ffaa00';
      tradeBtn.style.color = '#000';
      logit('已发送停止交易指令');
      alert('已发送停止交易指令，交易将在当前轮次完成后停止');
    }
  };

  section.appendChild(tradeBtn);

  return section;
}

/**
 * 创建分页调试信息显示区域
 */
function createPaginationDebugSection() {
  const section = document.createElement('div');
  section.style.cssText = `
    margin-top: 2px;
    padding: 3px;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid #ffffff;
    display: none;
  `;
  section.id = 'pagination-debug-section';

  const sectionTitle = document.createElement('div');
  sectionTitle.textContent = '[ PAGINATION DEBUG ]';
  sectionTitle.style.cssText = `
    font-weight: bold;
    margin-bottom: 3px;
    color: #ffffff;
    font-size: 10px;
    text-align: center;
    letter-spacing: 1px;
  `;

  const debugContent = document.createElement('div');
  debugContent.id = 'pagination-debug-content';
  debugContent.style.cssText = `
    font-family: 'Courier New', monospace;
    font-size: 8px;
    line-height: 1.1;
    text-align: left;
    color: #cccccc;
    max-height: 100px;
    overflow-y: auto;
    white-space: pre-wrap;
  `;
  debugContent.innerHTML = `
    <div>点击[DEBUG]按钮查看分页状态...</div>
  `;

  section.appendChild(sectionTitle);
  section.appendChild(debugContent);

  return section;
}

/**
 * 更新分页调试信息显示
 */
function updatePaginationDebugDisplay() {
  const section = document.getElementById('pagination-debug-section');
  const content = document.getElementById('pagination-debug-content');
  
  if (section && content) {
    section.style.display = 'block';
    content.textContent = paginationDebugInfo || '暂无调试信息';
  }
}

/**
 * 创建动态价格显示区域
 */
function createDynamicPriceSection() {
  const section = document.createElement('div');
  section.style.cssText = `
    margin-top: 2px;
    padding: 3px;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid #ffffff;
    display: none;
  `;
  section.id = 'dynamic-price-section';

  const sectionTitle = document.createElement('div');
  sectionTitle.textContent = '[ DYNAMIC PRICES ]';
  sectionTitle.style.cssText = `
    font-weight: bold;
    margin-bottom: 3px;
    color: #ffffff;
    font-size: 10px;
    text-align: center;
    letter-spacing: 1px;
  `;

  const priceContent = document.createElement('div');
  priceContent.id = 'dynamic-price-content';
  priceContent.style.cssText = `
    font-family: 'Courier New', monospace;
    font-size: 10px;
    line-height: 1.2;
    text-align: center;
    color: #cccccc;
  `;
  priceContent.innerHTML = `
    <div>等待动态价格计算...</div>
  `;

  section.appendChild(sectionTitle);
  section.appendChild(priceContent);

  return section;
}

/**
 * 更新动态价格显示
 */
function updateDynamicPriceDisplay(buyPrice, sellPrice) {
  const section = document.getElementById('dynamic-price-section');
  const content = document.getElementById('dynamic-price-content');
  
  if (section && content) {
    section.style.display = 'block';
    content.innerHTML = `
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 2px;">
        <div style="padding: 1px; background: rgba(255,255,255,0.1); border: 1px solid #ffffff;">
          <div style="color: #00ff00; font-weight: bold; margin-bottom: 1px; font-size: 10px;">BUY</div>
          <div style="color: #ffffff; font-size: 10px;">${buyPrice.toFixed(5)}</div>
        </div>
        <div style="padding: 1px; background: rgba(255,255,255,0.1); border: 1px solid #ffffff;">
          <div style="color: #ff6666; font-weight: bold; margin-bottom: 1px; font-size: 10px;">SELL</div>
          <div style="color: #ffffff; font-size: 10px;">${sellPrice.toFixed(5)}</div>
        </div>
      </div>
    `;
    
    // 保存当前动态价格
    currentDynamicPrices = { buyPrice, sellPrice };
  }
}

/**
 * 隐藏动态价格显示
 */
function hideDynamicPriceDisplay() {
  const section = document.getElementById('dynamic-price-section');
  if (section) {
    section.style.display = 'none';
  }
}

/**
 * 更新循环次数显示
 */
function updateCycleDisplay(completed, total) {
  const cycleDisplay = document.getElementById('cycle-display');
  if (cycleDisplay) {
    const remaining = total - completed;
    cycleDisplay.innerHTML = `
      <div style="color: #ffffff; font-weight: bold;">CYCLE PROGRESS</div>
      <div style="color: #00ff00;">COMPLETED: ${completed} / ${total}</div>
      <div style="color: #ffaa00;">REMAINING: ${remaining}</div>
    `;
  }
  // 更新全局变量
  completedTrades = completed;
}

/**
 * 创建交易统计区域
 */
function createStatsSection() {
  const section = document.createElement('div');
  section.style.cssText = `
    margin-top: 2px;
    padding: 3px;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid #ffffff;
    border-top: 2px solid #ffffff;
  `;

  const sectionTitle = document.createElement('div');
  sectionTitle.textContent = '[ TRADING STATS ]';
  sectionTitle.style.cssText = `
    font-weight: bold;
    margin-bottom: 3px;
    color: #ffffff;
    font-size: 10px;
    text-align: center;
    letter-spacing: 1px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  `;

  // 添加刷新按钮（合并CALC功能）
  const refreshBtn = document.createElement('button');
  refreshBtn.textContent = '[R]';
  refreshBtn.style.cssText = `
    background: none;
    border: 1px solid #ffffff;
    color: #ffffff;
    font-family: 'Courier New', monospace;
    font-size: 10px;
    cursor: pointer;
    padding: 1px 3px;
    transition: all 0.2s ease;
  `;

  refreshBtn.onmouseover = () => {
    refreshBtn.style.background = '#ffffff';
    refreshBtn.style.color = '#000';
  };
  refreshBtn.onmouseout = () => {
    refreshBtn.style.background = 'none';
    refreshBtn.style.color = '#ffffff';
  };
  refreshBtn.onclick = async () => {
    await updateStatsDisplay();
  };

  sectionTitle.appendChild(refreshBtn);

  // 创建统计内容容器
  const statsContent = document.createElement('div');
  statsContent.id = 'stats-content';
  statsContent.style.cssText = `
    font-family: 'Courier New', monospace;
    font-size: 10px;
    line-height: 1.2;
  `;

  // 创建循环次数显示
  const cycleDisplay = document.createElement('div');
  cycleDisplay.id = 'cycle-display';
  cycleDisplay.style.cssText = `
    margin-bottom: 4px;
    padding: 2px;
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid #ffffff;
    text-align: center;
    font-size: 9px;
  `;
  cycleDisplay.innerHTML = `
    <div style="color: #ffffff; font-weight: bold;">CYCLE PROGRESS</div>
    <div style="color: #00ff00;">COMPLETED: 0 / ${MAX_TRADES}</div>
    <div style="color: #ffaa00;">REMAINING: ${MAX_TRADES}</div>
  `;

  // 初始显示
  statsContent.innerHTML = `
    <div style="color: #999; text-align: center; padding: 4px; font-size: 10px;">
      CLICK [R] TO CALC
    </div>
  `;

  section.appendChild(cycleDisplay);

  section.appendChild(sectionTitle);
  section.appendChild(statsContent);

  return section;
}

/**
 * 更新统计显示
 */
async function updateStatsDisplay() {
  const statsContent = document.getElementById('stats-content');
  if (!statsContent) return;

  statsContent.innerHTML = `
    <div style="color: #ffff00; text-align: center; padding: 4px; font-size: 10px;">
      正在计算中...
    </div>
  `;

  // 同步计算统计
  await calculateTradingVolumeForPanel();
}

/**
 * 为控制面板计算交易量统计
 * 同步执行，确保在正确的tab页面获取DOM数据
 */
async function calculateTradingVolumeForPanel() {
  // 调用统一的统计函数，指定为控制面板模式
  await calculateTradingVolume(true);
}

// === 强制中断支持 ===
let stopTrading = false;
window.stopAlphaTrading = () => {
  stopTrading = true;
  logit("已收到 stopAlphaTrading 指令，自动交易将尽快中断...");
};

// === 全局控制函数 ===
window.showAlphaTradingPanel = () => {
  createControlPanel();
  logit("已重新打开 Alpha Trading 控制面板");
};

/**
 * 统一日期格式为 YYYY-MM-DD
 * @param {Date|string} date - 日期对象或日期字符串
 * @returns {string} 格式化的日期字符串
 */
function formatDateKey(date) {
  if (typeof date === 'string') {
    // 如果是字符串，先转换为Date对象
    date = new Date(date);
  }
  const result = date.toISOString().split('T')[0];
  logit(`DEBUG: formatDateKey - 输入: ${date}, 输出: "${result}"`);
  return result;
}

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
 * 智能等待元素出现并可选执行操作
 * 基于DOM状态动态等待，替代固定时间等待，提高脚本可靠性
 * 
 * @param {string|Function} selector - CSS选择器或返回元素的函数
 * @param {Function|null} checker - 可选的元素检查函数
 * @param {Function|null} onReady - 元素出现后要执行的操作（接收元素作为参数，可为async）
 * @param {number} maxAttempts - 最大尝试次数（默认10次）
 * @param {number} interval - 每次尝试间隔时间（毫秒，默认1500ms）
 * @param {number} initialDelay - 初始延迟时间（毫秒，默认1000ms）
 * @returns {Promise<any>} - 返回 onReady 的结果
 */
function waitForElement(
  selector,
  checker = null,
  onReady = null,
  maxAttempts = 10,
  interval = 500,
  initialDelay = 500
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
 * @param {number} amount - 币种数量
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
        setTimeout(checkOrder, 500 + Math.random() * 500);
      } else {
        setTimeout(checkOrder, 500 + Math.random() * 500);
      }
    };
    setTimeout(checkOrder, 1000);
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

  // 3. 卖出时优先将滑块拉满（百分比100%），并判断是否有可卖币种
  if (type === ORDER_TYPE.SELL) {
    const slider = document.querySelector('input[role="slider"]');
    if (slider) {
      setInputValue(slider, 100);
      if (slider.value === "0") {
        logit("卖出失败，无可用币种");
        return { status: "no_stock", message: "无可卖币种" };
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
      (type === ORDER_TYPE.BUY ? `和数量${volume}` : "，全部可卖币种")
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
    await waitForElement('.ReactVirtualized__Grid', null, null, 5);
    
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
 * 检查24h成交量是否足够，不足500M则不交易
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
      5
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
      alert(`24 小时成交量低于 ${MIN_VOLUME_M}M (当前: ${volumeInM}M)，检查未通过，停止自动交易`);
      return false;
    }
    
    logit(`成交量充足 (${volumeInM}M)，可以开始交易`);
    return true;
  } catch (error) {
    logit("检查成交量时出错:", error);
    return false;
  }
}

/**
 * 主交易循环，自动买入卖出交易
 * 支持动态价格计算、智能等待、实时统计等功能
 */
async function startTrading() {
  // 开始前检查成交量
  const volumeOk = await checkVolumeBeforeTrading();
  if (!volumeOk) {
    logit("成交量检查未通过，停止自动刷单");
    return;
  }
  
  // 成交量检查通过，弹窗提示开始交易
  logit("成交量检查通过，开始自动交易");
  
  let tradeCount = 0;
  while (tradeCount < MAX_TRADES) {
    if (stopTrading) {
      logit("检测到 stopTrading 标志，自动交易已被强制中断");
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
          
          // 更新面板显示
          updateDynamicPriceDisplay(currentBuyPrice, currentSellPrice);
        } else {
          logit("动态价格获取失败，使用默认价格");
          hideDynamicPriceDisplay();
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
          
          // 更新循环次数显示
          updateCycleDisplay(tradeCount, MAX_TRADES);
          
          // 每3轮交易计算一次统计，或者最后一轮完成时计算
          if (tradeCount % 3 === 0 || tradeCount >= MAX_TRADES) {
            logit(`第${tradeCount}轮交易完成，计算统计数据...`);
            // 同步计算统计，确保在正确的tab页面
            await calculateTradingVolumeForPanel();
          }
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
    logit("已完成设定的交易轮数");
    updateCycleDisplay(MAX_TRADES, MAX_TRADES);
    alert("已完成设定的交易轮数");
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
    
    // 等待交易容器加载
    const tradeContainer = await waitForElement('div.bg-TradeBg div.order-6', null, null, 10);
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
        // 等待限价标签激活
        await waitForElement('#bn-tab-0[aria-selected="true"]', null, null, 5);
      } else {
        logit("未找到「限价」标签");
      }
    } catch (error) {
      logit("点击「限价」标签失败:", error);
    }
    
    // 点击「1周」时间范围 - 限制在容器内查找
    try {
      // 查找包含"1周"文本的div元素
      let oneDayButton = null;
      const divs = tradeContainer.querySelectorAll('div');
      
      for (const div of divs) {
        if (div.textContent === '1周') {
          oneDayButton = div;
          break;
        }
      }
      
      if (!oneDayButton) {
        // 查找具有特定样式的按钮（通过CSS变量背景色）
        const buttons = tradeContainer.querySelectorAll('div[style*="background-color: var(--color-bg3)"]');
        for (const button of buttons) {
          if (button.textContent === '1周') {
            oneDayButton = button;
            break;
          }
        }
      }
      
      if (!oneDayButton) {
        // 查找所有可能的时间范围按钮
        const timeButtons = tradeContainer.querySelectorAll('div[style*="min-width: 48px"]');
        for (const button of timeButtons) {
          if (button.textContent === '1周') {
            oneDayButton = button;
            break;
          }
        }
      }
      
      if (oneDayButton) {
        oneDayButton.click();
        logit("已点击「1周」时间范围");
        // 等待时间范围按钮激活
        await waitForElement('div[style*="background-color: var(--color-bg3)"]', null, null, 5);
      } else {
        logit("未找到「1周」时间范围按钮，尝试查找所有时间按钮...");
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
      logit("点击「1周」时间范围失败:", error);
    }
    
    // 等待表格加载
    await waitForElement('table', null, null, 10);
    return true;
  } catch (error) {
    logit("点击委托历史标签页失败:", error);
    return false;
  }
}

/**
 * 点击重置按钮，回到第一页
 */
async function clickResetButton() {
  try {
    logit("DEBUG: 开始点击重置按钮...");
    
    // 查找重置按钮 - 多种选择器
    let resetButton = document.querySelector('button.bn-button__text__black div[style*="font-weight: 500"]') ||
                     document.querySelector('button.bn-button__text__black') ||
                     Array.from(document.querySelectorAll('button')).find(btn => 
                       btn.textContent.includes('重置') || 
                       btn.querySelector('div')?.textContent.includes('重置')
                     );
    
    if (!resetButton) {
      // 尝试更宽泛的查找
      resetButton = Array.from(document.querySelectorAll('button')).find(btn => {
        const text = btn.textContent || btn.querySelector('div')?.textContent || '';
        return text.includes('重置');
      });
    }
    
    if (!resetButton) {
      logit("DEBUG: 未找到重置按钮");
      return false;
    }
    
    logit("DEBUG: 找到重置按钮，点击...");
    resetButton.click();
    
    // 等待页面重置
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // 验证是否回到第一页
    const activePage = document.querySelector('.bn-pagination-item.active');
    if (activePage && activePage.textContent === '1') {
      logit("DEBUG: 重置成功，已回到第一页");
      return true;
    } else {
      logit("DEBUG: 重置可能失败，当前页码: " + (activePage ? activePage.textContent : 'unknown'));
      return false;
    }
    
  } catch (error) {
    logit("点击重置按钮失败:", error);
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
    // 确保row是有效的DOM元素
    if (!row || !row.querySelectorAll) {
      logit(`DEBUG: 无效的DOM行元素`);
      return null;
    }
    
    // 检查是否是测量行
    if (row.classList.contains('bn-web-table-measure-row') || row.getAttribute('aria-hidden') === 'true') {
      logit(`DEBUG: 跳过测量行`);
      return null;
    }
    
    // 尝试多种单元格选择器
    let cells = row.querySelectorAll('.bn-web-table-cell');
    if (cells.length === 0) {
      cells = row.querySelectorAll('td');
    }
    if (cells.length === 0) {
      cells = row.querySelectorAll('th');
    }
    
    if (cells.length < 10) {
      logit(`DEBUG: 单元格数量不足，期望至少10个，实际${cells.length}个`);
      return null;
    }
    
    // 根据实际的列结构解析数据
    // 列结构: 展开图标(0) | 创建时间(1) | 代币(2) | 类型(3) | 方向(4) | 平均价格(5) | 价格(6) | 已成交(7) | 数量(8) | 成交额(9) | 状态(10)
    
    // 获取时间（第2列，索引1）
    const timeCell = cells[1];
    const timeText = timeCell?.textContent?.trim();
    
    if (!timeText || !/^\d{4}-\d{2}-\d{2}/.test(timeText)) {
      logit(`DEBUG: 时间文本无效: ${timeText}`);
      return null;
    }
    
    // 获取交易方向（第5列，索引4）
    const directionCell = cells[4];
    let direction = '';
    if (directionCell) {
      direction = directionCell.textContent?.trim();
      // 也检查子元素
      if (!direction) {
        const subElement = directionCell.querySelector('div');
        if (subElement) {
          direction = subElement.textContent?.trim();
        }
      }
    }
    
    if (!direction || (!direction.includes('买入') && !direction.includes('卖出'))) {
      logit(`DEBUG: 交易方向无效: ${direction}`);
      return null;
    }
    
    // 获取已成交数量（第8列，索引7）
    const filledCell = cells[7];
    const filledText = filledCell?.textContent?.trim();
    
    if (!filledText) {
      logit(`DEBUG: 已成交数量为空`);
      return null;
    }
    
    // 获取状态（第11列，索引10）
    const statusCell = cells[10];
    let status = '';
    if (statusCell) {
      status = statusCell.textContent?.trim();
      // 也检查子元素
      if (!status) {
        const subElement = statusCell.querySelector('div');
        if (subElement) {
          status = subElement.textContent?.trim();
        }
      }
    }
    
    if (!status || !status.includes('已成交')) {
      logit(`DEBUG: 状态无效: ${status}`);
      return null;
    }
    
    // 只处理已成交的订单
    if (!status.includes('已成交')) {
      logit(`DEBUG: 订单状态不是已成交: ${status}`);
      return null;
    }
    
    // 解析时间
    const date = new Date(timeText);
    if (isNaN(date.getTime())) {
      logit(`DEBUG: 时间解析失败: ${timeText}`);
      return null;
    }
    
    // 解析已成交数量（第7列，索引6）
    const volumeMatch = filledText.match(/[\d.]+/);
    const volume = volumeMatch ? Math.round(parseFloat(volumeMatch[0]) * 100000000) / 100000000 : 0;
    
    if (volume === 0) {
      logit(`DEBUG: 数量解析失败或为0: ${filledText}`);
      return null;
    }
    
    logit(`DEBUG: 数量解析结果: ${volume}`);
    
    // 获取价格信息（第7列，索引6）
    let price = 0;
    try {
      const priceCell = cells[6];
      const priceText = priceCell?.textContent?.trim();
      if (priceText && /[\d.]+/.test(priceText)) {
        const priceMatch = priceText.match(/[\d.]+/);
        if (priceMatch) {
          price = Math.round(parseFloat(priceMatch[0]) * 100000000) / 100000000;
          logit(`DEBUG: 价格解析结果: ${price}`);
        }
      }
    } catch (error) {
      logit(`DEBUG: 价格解析失败: ${error.message}`);
    }
    
    // 获取成交额（第10列，索引9）
    let totalValue = 0;
    try {
      const totalValueCell = cells[9];
      const totalValueText = totalValueCell?.textContent?.trim();
      if (totalValueText && /[\d,]+\.?\d*/.test(totalValueText)) {
        const totalValueMatch = totalValueText.match(/[\d,]+\.?\d*/);
        if (totalValueMatch) {
          const cleanValue = totalValueMatch[0].replace(/,/g, '');
          totalValue = Math.round(parseFloat(cleanValue) * 100000000) / 100000000;
          logit(`DEBUG: 成交额解析结果: ${totalValue} (原始: ${cleanValue})`);
        }
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
    
    // 调试：显示所有列的内容
    logit(`DEBUG: 所有列内容:`);
    for (let i = 0; i < Math.min(cells.length, 10); i++) {
      const cellText = cells[i]?.textContent?.trim() || '';
      logit(`DEBUG: 列${i + 1}: "${cellText}"`);
    }
    
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
async function getCurrentPageTradesForVolumeCalc() {
  const trades = [];
  try {
    // 等待表格行加载，使用更宽松的等待条件
    try {
      await waitForElement('table tbody tr', null, null, 5);
    } catch (error) {
      logit("等待表格行加载超时，尝试直接查找:", error.message);
    }
    
    // 尝试多种表格选择器，排除测量行
    let rows = document.querySelectorAll('.bn-web-table-tbody .bn-web-table-row:not(.bn-web-table-measure-row)');
    
    if (rows.length === 0) {
      // 尝试更宽泛的选择器
      rows = document.querySelectorAll('table tbody tr:not(.bn-web-table-measure-row)');
      logit(`DEBUG: 使用 table tbody tr 选择器，找到 ${rows.length} 行`);
    }
    
    if (rows.length === 0) {
      // 尝试查找所有可能的行
      rows = document.querySelectorAll('tbody tr:not(.bn-web-table-measure-row)');
      logit(`DEBUG: 使用 tbody tr 选择器，找到 ${rows.length} 行`);
    }
    
    if (rows.length === 0) {
      // 最后尝试查找任何包含数据的行
      rows = document.querySelectorAll('tr:not(.bn-web-table-measure-row)');
      logit(`DEBUG: 使用 tr 选择器，找到 ${rows.length} 行`);
    }
    
    logit(`DEBUG: 最终找到 ${rows.length} 行数据`);
    
    // 遍历每一行
    rows.forEach((row, index) => {
      // 检查行是否包含必要的单元格
      const cells = row.querySelectorAll('.bn-web-table-cell');
      
      // 如果找不到标准单元格，尝试其他选择器
      let actualCells = cells;
      if (cells.length === 0) {
        actualCells = row.querySelectorAll('td');
      }
      if (actualCells.length === 0) {
        actualCells = row.querySelectorAll('th');
      }
      
      logit(`DEBUG: 第${index + 1}行 - 单元格数量: ${actualCells.length}`);
      
      if (actualCells.length >= 8) { // 降低要求，至少8个单元格
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
 * 调试分页状态
 */
function debugPaginationStatus() {
  try {
    logit("=== 分页调试信息 ===");
    
    let debugInfo = "=== 分页调试信息 ===\n";
    
    // 查找当前页码
    const activePage = document.querySelector('.bn-pagination-item.active');
    if (activePage) {
      const pageInfo = `当前页码: ${activePage.textContent}`;
      logit(pageInfo);
      debugInfo += pageInfo + "\n";
    }
    
    // 查找所有页码按钮
    const allPages = document.querySelectorAll('.bn-pagination-item');
    const pageInfo = `找到 ${allPages.length} 个页码按钮`;
    logit(pageInfo);
    debugInfo += pageInfo + "\n";
    
    allPages.forEach((page, index) => {
      const isActive = page.classList.contains('active');
      const pageNum = page.textContent;
      const pageInfo = `页码${index + 1}: ${pageNum} - 激活状态: ${isActive}`;
      logit(pageInfo);
      debugInfo += pageInfo + "\n";
    });
    
    // 检查是否有下一页
    const hasNext = hasNextPageForVolumeCalc();
    const nextInfo = `是否有下一页: ${hasNext}`;
    logit(nextInfo);
    debugInfo += nextInfo + "\n";
    
    debugInfo += "=== 分页调试信息结束 ===";
    logit("=== 分页调试信息结束 ===");
    
    // 更新全局变量
    paginationDebugInfo = debugInfo;
    
  } catch (error) {
    const errorInfo = `调试分页状态失败: ${error.message}`;
    logit(errorInfo);
    paginationDebugInfo = errorInfo;
  }
}

/**
 * 检查是否有下一页
 * @returns {boolean} 是否有下一页
 */
function hasNextPageForVolumeCalc() {
  try {
    // 查找当前页码
    const activePage = document.querySelector('.bn-pagination-item.active');
    if (!activePage) {
      logit("未找到当前页码");
      return false;
    }
    
    const currentPage = parseInt(activePage.textContent);
    
    // 查找所有页码按钮
    const allPages = document.querySelectorAll('.bn-pagination-item');
    let maxPage = 0;
    
    allPages.forEach(page => {
      const pageNum = parseInt(page.textContent);
      if (!isNaN(pageNum) && pageNum > maxPage) {
        maxPage = pageNum;
      }
    });
    
    logit(`当前页码: ${currentPage}, 最大页码: ${maxPage}`);
    return currentPage < maxPage;
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
    // 查找当前页码
    const activePage = document.querySelector('.bn-pagination-item.active');
    if (!activePage) {
      logit("未找到当前页码");
      return false;
    }
    
    const currentPage = parseInt(activePage.textContent);
    const nextPage = currentPage + 1;
    
    logit(`准备从第 ${currentPage} 页翻到第 ${nextPage} 页...`);
    
    // 查找下一页的页码按钮
    const nextPageButton = Array.from(document.querySelectorAll('.bn-pagination-item')).find(button => {
      return parseInt(button.textContent) === nextPage;
    });
    
    if (!nextPageButton) {
      logit(`未找到第 ${nextPage} 页按钮`);
      return false;
    }
    
    logit(`找到第 ${nextPage} 页按钮，点击...`);
    nextPageButton.click();
    
    // 等待页面加载
    // await new Promise(resolve => setTimeout(resolve, 500));
    
    // 验证翻页是否成功
    const newActivePage = document.querySelector('.bn-pagination-item.active');
    if (newActivePage && parseInt(newActivePage.textContent) === nextPage) {
      logit(`成功翻到第 ${nextPage} 页`);
      return true;
    } else {
      logit(`翻页失败，当前页码: ${newActivePage ? newActivePage.textContent : 'unknown'}`);
      return false;
    }
    
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
    const todayKey = formatDateKey(new Date(new Date().getTime() - 8 * 60 *60 *1000));
  
  logit(`DEBUG: 今日日期（8点分界）: ${todayKey}`);
  logit(`DEBUG: 总共需要处理的交易数量: ${trades.length}`);
  
  let processedCount = 0;
  let todayCount = 0;
  
  trades.forEach((trade, index) => {
    processedCount++;
    
    // 调整时间：如果时间在0-7:59，算作前一天的交易
    // 如果时间在8:00-23:59，算作当天的交易
    let tradeDate = new Date(trade.time);
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
    
    const dateKey = formatDateKey(tradeDate);
    
    logit(`DEBUG: 交易归属日期: ${dateKey}, 是否今日: ${dateKey === todayKey}, 交易日期: "${dateKey}", 今日日期: "${todayKey}", 长度: ${dateKey.length}/${todayKey.length}, 类型: ${typeof dateKey}/${typeof todayKey}`);
    
    // 只统计今日的交易
    if (dateKey === todayKey) {
      todayCount++;
      if (!dailyStats[dateKey]) {
        dailyStats[dateKey] = {
          date: dateKey,
                  totalVolume: 0, // 币种总量
        totalValue: 0, // USDT成交额总量
        tradeCount: 0,
        trades: [],
        buyTrades: [],
        sellTrades: [],
        totalBuyVolume: 0, // 币种买入量
        totalSellVolume: 0, // 币种卖出量
        totalBuyValue: 0, // USDT买入成交额
        totalSellValue: 0, // USDT卖出成交额
        wearLoss: 0, // 磨损损失（USDT）
        wearLossPercentage: 0 // 磨损百分比
        };
      }
      
      dailyStats[dateKey].totalVolume += trade.volume; // 币种总量
      dailyStats[dateKey].tradeCount += 1;
      dailyStats[dateKey].trades.push(trade);
      
      logit(`DEBUG: 今日第${todayCount}笔交易 - 方向: ${trade.direction}, 数量: ${trade.volume}, 成交额: ${trade.totalValue}`);
      
      // 分别统计买入和卖出
      if (trade.isBuy) {
        dailyStats[dateKey].buyTrades.push(trade);
        dailyStats[dateKey].totalBuyVolume = Math.round((dailyStats[dateKey].totalBuyVolume + trade.volume) * 100000000) / 100000000; // 币种买入量
        dailyStats[dateKey].totalBuyValue = Math.round((dailyStats[dateKey].totalBuyValue + trade.totalValue) * 100000000) / 100000000; // USDT买入成交额
        // 成交总额只算买入
        dailyStats[dateKey].totalValue = Math.round((dailyStats[dateKey].totalValue + trade.totalValue) * 100000000) / 100000000;
        logit(`DEBUG: 买入交易 - 累计买入量: ${dailyStats[dateKey].totalBuyVolume}, 累计买入额: ${dailyStats[dateKey].totalBuyValue}`);
      } else if (trade.isSell) {
        dailyStats[dateKey].sellTrades.push(trade);
        dailyStats[dateKey].totalSellVolume = Math.round((dailyStats[dateKey].totalSellVolume + trade.volume) * 100000000) / 100000000; // 币种卖出量
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
      
      logit(`📊 ${dateKey} 磨损统计: 磨损${stats.wearLoss.toFixed(4)} USDT (${stats.wearLossPercentage.toFixed(2)}%)`);
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
    const todayKey = formatDateKey(new Date(new Date().getTime() - 8 * 60 *60 *1000))
    
    // 获取当前页面的所有交易行，排除测量行
    let rows = document.querySelectorAll('.bn-web-table-tbody .bn-web-table-row:not(.bn-web-table-measure-row)');
    if (rows.length === 0) {
      rows = document.querySelectorAll('table tbody tr:not(.bn-web-table-measure-row)');
    }
    if (rows.length === 0) {
      rows = document.querySelectorAll('tbody tr:not(.bn-web-table-measure-row)');
    }
    
    let foundNonTodayTrade = false;
    let todayTradeCount = 0;
    
    // 检查每一行，统计今日交易数量并检查是否有非今日交易
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
            const dateKey = formatDateKey(adjustedDate);
            
            if (dateKey === todayKey) {
              todayTradeCount++;
            } else {
              foundNonTodayTrade = true;
              logit(`发现非今日交易: ${timeText} -> ${dateKey}，停止翻页`);
              break;
            }
          }
        }
      }
    }
    
    // 如果当前页没有今日交易，停止翻页（说明已经翻过了）
    if (todayTradeCount === 0) {
      logit(`当前页没有今日交易，停止翻页`);
      return true;
    }
    
    // 如果当前页有今日交易，继续翻页（即使也有非今日交易）
    logit(`当前页有 ${todayTradeCount} 笔今日交易，继续翻页`);
    return false;
    
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
    // 确保从第一页开始，先重置分页状态
    logit("确保从第一页开始获取数据...");
    const resetClicked = await clickResetButton();
    if (resetClicked) {
      logit("重置成功，从第一页开始");
      // 等待重置完成
      await new Promise(resolve => setTimeout(resolve, 2000));
    } else {
      logit("重置失败，但继续执行...");
    }
    
    // 先获取第一页数据
    let currentPageTrades = await getCurrentPageTradesForVolumeCalc();
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
      
      // 等待页面加载
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // 先获取当前页面的数据
      currentPageTrades = await getCurrentPageTradesForVolumeCalc();
      allTrades.push(...currentPageTrades);
      pageCount++;
      
      logit(`第 ${pageCount} 页: 获取到 ${currentPageTrades.length} 笔交易`);
      
      // 检查当前页面是否包含非今日交易，如果包含就停止翻页
      if (shouldStopPagination()) {
        logit(`第 ${pageCount} 页超出今日范围，停止翻页`);
        break;
      }
      
      logit(`第 ${pageCount} 页: 获取到 ${currentPageTrades.length} 笔交易`);
      
      // 如果当前页没有数据，可能已经到最后一页
      if (currentPageTrades.length === 0) {
        logit("当前页没有数据，可能已到最后一页");
        break;
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
async function calculateTradingVolume(isPanelMode = false) {
  try {
    logit(`开始计算交易量统计... (${isPanelMode ? '控制面板模式' : '详细模式'})`);
    
    // 控制面板模式处理
    if (isPanelMode) {
      const statsContent = document.getElementById('stats-content');
      if (!statsContent) return;

      // 显示计算中状态
      statsContent.innerHTML = `
        <div style="color: #ffff00; text-align: center; padding: 4px; font-size: 10px;">
          GETTING DATA...
        </div>
      `;
    }
    
    // 1. 点击委托历史标签页
    logit("DEBUG: 开始点击委托历史标签页...");
    const tabClicked = await clickOrderHistoryTabForVolumeCalc();
    if (!tabClicked) {
      const errorMsg = "无法访问委托历史页面";
      logit(errorMsg);
      if (isPanelMode) {
        const statsContent = document.getElementById('stats-content');
        if (statsContent) {
          statsContent.innerHTML = `
            <div style="color: #ff6666; text-align: center; padding: 4px; font-size: 10px;">
              NO ACCESS TO HISTORY
            </div>
          `;
        }
      } else {
        alert(errorMsg);
      }
      return;
    }
    
    // 2. 点击重置按钮，确保从第一页开始
    logit("DEBUG: 开始点击重置按钮...");
    const resetClicked = await clickResetButton();
    if (!resetClicked) {
      logit("DEBUG: 重置按钮点击失败，但继续执行...");
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
      if (isPanelMode) {
        const statsContent = document.getElementById('stats-content');
        if (statsContent) {
          statsContent.innerHTML = `
            <div style="color: #ff6666; text-align: center; padding: 4px; font-size: 10px;">
              NO TRADES FOUND
            </div>
          `;
        }
      } else {
        alert(errorMsg);
      }
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
    
    const todayKey = formatDateKey(new Date(new Date().getTime() - 8 * 60 *60 *1000));
    
    console.log(`统计日期: ${todayKey} (8点分界)`);
    console.log(`总成交订单数: ${allTrades.length}`);
    console.log(`今日买入订单数: ${Object.keys(dailyStats).length > 0 ? dailyStats[todayKey]?.buyTrades?.length || 0 : 0}`);
    console.log("");
    
    // 只显示今日的统计
    if (Object.keys(dailyStats).length > 0 && dailyStats[todayKey]) {
      const stats = dailyStats[todayKey];
      console.log(`今日 (${todayKey}) 统计:`);
      console.log(`  买入订单数: ${stats.buyTrades?.length || 0}`);
      console.log(`  买入总量: ${stats.totalBuyVolume?.toFixed(4) || '0.0000'} 币种`);
      console.log(`  平均每笔: ${stats.buyTrades?.length > 0 ? (stats.totalBuyVolume / stats.buyTrades.length).toFixed(4) : '0.0000'} 币种`);
      console.log("");
    } else {
      console.log(`今日 (${todayKey}) 暂无买入订单`);
      console.log("");
    }
    
    // 计算今日统计
    const todayTrades = Object.keys(dailyStats).length > 0 && dailyStats[todayKey] ? dailyStats[todayKey].trades : [];
    const todayBuyTrades = Object.keys(dailyStats).length > 0 && dailyStats[todayKey] ? dailyStats[todayKey].buyTrades : [];
    const todayTotalVolume = todayBuyTrades.reduce((sum, trade) => Math.round((sum + trade.volume) * 100000000) / 100000000, 0); // 币种买入总量
    const todayTotalValue = todayBuyTrades.reduce((sum, trade) => Math.round((sum + trade.totalValue) * 100000000) / 100000000, 0); // USDT买入成交额总量
    const todayAvgVolume = todayBuyTrades.length > 0 ? Math.round((todayTotalVolume / todayBuyTrades.length) * 100000000) / 100000000 : 0; // 平均币种
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
    console.log(`今日买入总量: ${todayTotalVolume.toFixed(4)} 币种`);
    console.log(`今日买入总额: ${todayTotalValue.toFixed(2)} USDT`);
    console.log(`今日平均每笔数量: ${todayAvgVolume.toFixed(4)} 币种`);
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
    
    // 5. 根据模式显示结果
    if (isPanelMode) {
      // 控制面板模式：更新控制面板显示
      const statsContent = document.getElementById('stats-content');
      if (statsContent) {
        statsContent.innerHTML = `
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1px; font-size: 10px;">
            <div style="padding: 0px; background: rgba(255,255,255,0.1); border: 1px solid #ffffff;">
              <div style="color: #ffffff; font-weight: bold; margin-bottom: 1px;">${todayKey}</div>
              <div style="display: flex; justify-content: space-between;">
                <span style="color: #ffffff;">BUY:</span>
                <span style="color: #ffffff;">${todayBuyCount}笔</span>
              </div>
              <div style="display: flex; justify-content: space-between;">
                <span style="color: #ffffff;">SELL:</span>
                <span style="color: #ffffff;">${todaySellCount}笔</span>
              </div>
            </div>
            <div style="padding: 0px; background: rgba(255,255,255,0.1); border: 1px solid #ffffff;">
              <div style="color: #ffffff; font-weight: bold; margin-bottom: 1px;">TRADE</div>
              <div style="display: flex; justify-content: space-between;">
                <span style="color: #ffffff;">TOTAL:</span>
                <span style="color: #ffffff;">${todayTotalValue.toFixed(0)}</span>
              </div>
              <div style="display: flex; justify-content: space-between;">
                <span style="color: #ffffff;">AVG:</span>
                <span style="color: #ffffff;">${todayAvgValue.toFixed(0)}</span>
              </div>
            </div>
            <div style="padding: 0px; background: rgba(255,255,255,0.1); border: 1px solid #ffffff;">
              <div style="color: #ffffff; font-weight: bold; margin-bottom: 1px;">4X</div>
              <div style="text-align: center; color: #ffffff;">
                ${(todayTotalValue * 4).toFixed(0)} USDT
              </div>
            </div>
            <div style="padding: 0px; background: rgba(255,255,255,0.1); border: 1px solid #ffffff;">
              <div style="color: #ffffff; font-weight: bold; margin-bottom: 1px;">WEAR</div>
              <div style="display: flex; justify-content: space-between;">
                <span style="color: #ffffff;">LOSS:</span>
                <span style="color: ${todayWearLoss > 0 ? '#ff6666' : '#ffffff'};">${todayWearLoss.toFixed(2)}</span>
              </div>
              <div style="display: flex; justify-content: space-between;">
                <span style="color: #ffffff;">RATE:</span>
                <span style="color: ${todayWearLossPercentage > 0 ? '#ff6666' : '#ffffff'};">${todayWearLossPercentage.toFixed(2)}%</span>
              </div>
            </div>
          </div>
        `;
      }
      logit("控制面板统计更新完成");
    } else {
      // 详细模式：创建独立的DOM界面
      createTradingStatsDisplay(
        todayKey, 
        todayTotalValue, // USDT买入成交额总量
        todayAvgValue, // 平均每笔USDT成交额
        todayWearLoss,
        todayWearLossPercentage
      );
      logit("交易量统计完成，请查看控制台输出和页面显示");
    }
    
  } catch (error) {
    const errorMsg = `计算交易量统计失败: ${error.message}`;
    logit(errorMsg);
    console.error("交易量统计错误:", error);
    
    if (isPanelMode) {
      const statsContent = document.getElementById('stats-content');
      if (statsContent) {
        statsContent.innerHTML = `
          <div style="color: #ff6666; text-align: center; padding: 4px; font-size: 10px;">
            CALC ERROR: ${error.message}
          </div>
        `;
      }
    } else {
      alert(errorMsg);
    }
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

// === 启动悬浮控制面板 ===
// 延迟一秒后创建控制面板，让页面完全加载
setTimeout(() => {
  createControlPanel();
}, 1000);
