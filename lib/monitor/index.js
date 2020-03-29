'use strict'

const colors = require('colors')
const signale = require('signale')
const _min = require('lodash/min')
const _isEmpty = require('lodash/isEmpty')
const _isFinite = require('lodash/isFinite')
const moment = require('moment')
const blessed = require('blessed')
const blessedContrib = require('blessed-contrib')
const { sprintf } = require('sprintf-js')
const notifier = require('node-notifier')
const { WSv2 } = require('bitfinex-api-node')
const { EMA } = require('bfx-hf-indicators')
const { RESTv2 } = require('bfx-api-node-rest')
const { Order } = require('bfx-api-node-models')
const { prepareAmount, preparePrice } = require('bfx-api-node-util')
const { TYPES } = require('./commands/prime')
const commands = require('./commands')

const DEFAULT_TRADE_SIZE_ALERT_THRESHOLD = 0.75
const DEFAULT_GROUP_SIZE_ALERT_THRESHOLD = 3
const DEFAULT_LEFT_CHART_WINDOW = 180
const DEFAULT_RIGHT_CHART_WINDOW = 30
const DEFUALT_EMA_PERIOD = 30

const USTAR = '★'
const AUTO_STATUS_BLINK_INTERVAL_MS = 0.5 * 1000

class Monitor {
  constructor ({ apiKey, apiSecret }) {
    const self = this

    this.candles = {} // mts: candle
    this.startMTS = Date.now()
    this.lastTradeAmount = 0
    this.lastTradePrice = null
    this.tradeSizeAlertThreshold = DEFAULT_TRADE_SIZE_ALERT_THRESHOLD
    this.groupSizeAlertThreshold = DEFAULT_GROUP_SIZE_ALERT_THRESHOLD
    this.emaPeriod = DEFUALT_EMA_PERIOD
    this.leftChartWindow = DEFAULT_LEFT_CHART_WINDOW
    this.rightChartWindow = DEFAULT_RIGHT_CHART_WINDOW
    this.autoStatusBlinkInterval = null
    this.quickOrderSize = 0
    this.marginInfo = {}
    this.primes = []
    this.orderHistory = []
    this.minTradeSize = 0
    this.maxLeverage = 0
    this.rest = new RESTv2({
      transform: true,
      apiKey: apiKey,
      apiSecret: apiSecret
    })

    this.onRecvTrade = this.onRecvTrade.bind(this)
    this.onRecvCandles = this.onRecvCandles.bind(this)
    this.onWriteConsoleOutput = this.onWriteConsoleOutput.bind(this)

    this.screen = blessed.screen({
      smartCSR: true,
      autoPadding: true,
      dockBorders: true,
      fullUnicode: true
    })

    this.screen.enableInput()
    this.screen.title = 'Bitfinex Market Monitor'
    this.screen.key(['escape', 'q', 'C-c'], () => {
      this.screen.destroy()
      process.exit(0) // eslint-disable-line
    })

    this.screenGrid = new blessedContrib.grid({ // eslint-disable-line
      rows: 20,
      cols: 8,
      screen: this.screen
    })

    this.screenLogBox = this.screenGrid.set(0, 0, 2, 4, blessedContrib.log, {
      label: 'Internal Log',
      scrollable: true,
      enableInput: true
    })

    this.screenPositionStatusBox = this.screenGrid.set(0, 4, 2, 4, blessed.element, {
      border: { type: 'line' },
      label: 'Position',
      tags: true,
      align: 'center',
      valign: 'middle'
    })

    this.screenLastBuyGroupBox = this.screenGrid.set(2, 0, 1, 2, blessed.element, {
      border: { type: 'line' },
      label: 'Last Buy Group',
      tags: true,
      align: 'center',
      valign: 'middle'
    })

    this.screenLastSellGroupBox = this.screenGrid.set(3, 0, 1, 2, blessed.element, {
      border: { type: 'line' },
      label: 'Last Sell Group',
      tags: true,
      align: 'center',
      valign: 'middle'
    })

    this.screenAutoStatus = this.screenGrid.set(4, 0, 1, 2, blessed.element, {
      border: { type: 'line' },
      label: 'Auto Status',
      align: 'center',
      valign: 'middle'
    })

    this.screenTradeBox = this.screenGrid.set(2, 2, 9, 1, blessed.box, {
      border: { type: 'line' },
      label: 'Trade Log',
      scrollable: true,
      alwaysScroll: true,
      align: 'center'
    })

    this.screenStatusBox = this.screenGrid.set(5, 0, 6, 2, blessed.box, {
      label: 'Status'
    })

    this.screenOrderLogBox = this.screenGrid.set(11, 0, 3, 4, blessedContrib.log, {
      label: 'Order Log'
    })

    this.screenConsoleOutputBox = this.screenGrid.set(2, 4, 11, 4, blessedContrib.log, {
      label: 'Console Output',
      mouse: true,
      scrollable: true,
      scrollbar: {
        ch: '|',
        track: { bg: 'black' }
      },
      style: {
        scrollbar: { fg: 'green' }
      }
    })

    this.screenConsoleInputBox = this.screenGrid.set(12, 4, 2, 4, blessed.textarea, {
      label: 'Console Input',
      inputOnFocus: true,
      mouse: true,
      style: {
        border: { fg: 'white' },
        focus: {
          border: { fg: 'green' }
        }
      }
    })

    this.screenConsoleInputBox.focus()

    this.screenConsoleInputBox.key('enter', function () {
      self.onSubmitConsoleInput(this.getValue())
      this.clearValue()
      self.screen.render()
    })

    this.screenGraphLeft = this.screenGrid.set(14, 0, 6, 5, blessedContrib.line, {
      label: `${this.leftChartWindow}min Price & EMA(${this.emaPeriod})`,
      wholeNumbersOnly: false,
      xPadding: 3,
      xLabelPadding: 3,
      style: {
        line: 'white',
        text: 'green',
        baseline: 'green'
      }
    })

    this.screenGraphRight = this.screenGrid.set(14, 5, 6, 3, blessedContrib.line, {
      label: `${this.rightChartWindow}min Price & EMA(${this.emaPeriod})`,
      wholeNumbersOnly: false,
      xPadding: 3,
      xLabelPadding: 3,
      style: {
        line: 'white',
        text: 'green',
        baseline: 'green'
      }
    })

    this.screen.render()

    const writableLogBoxStream = {
      end: () => this.screen.render(),
      write: (data) => {
        this.screenLogBox.log(data.slice(0, data.length - 1))
      }
    }

    this.l = new signale.Signale({ stream: writableLogBoxStream, scope: 'monitor' })
    this.lws = new signale.Signale({ stream: writableLogBoxStream, scope: 'wsv2' })

    this.l.star('Starting (%s)', new Date().toLocaleString())

    this.ws = new WSv2({
      transform: true,
      apiKey,
      apiSecret
    })

    this.ws.on('error', (err) => {
      this.lws.error(err)
    })

    this.commands = commands.map(cmd => cmd(this, this.onWriteConsoleOutput))
    this.onWriteConsoleOutput('Ready for commands')
    this.updateStatus()
    this.updatePositionStatus()
    this.clearAutoStatus()

    setInterval(() => {
      this.updateOrderLog()
    }, 1000)
  }

  setupPrime ({ type, threshold, amount, tif }) {
    if (this.primes.find(p => p.type === type && p.threshold === threshold)) {
      throw new Error(
        `Prime rule already exists for type ${type} with threshold ${threshold}`
      )
    }

    this.primes.push({ type, threshold, amount, tif })
    this.updateStatus()

    if (this.primes.length === 1) {
      this.setPrimedAutoStatus()
    }
  }

  getPosition () {
    return this.position
  }

  getSymbol () {
    return this.symbol
  }

  getCommands () {
    return this.commands
  }

  async onSubmitConsoleInput (value) {
    const input = value.trim()
    const cmd = this.commands.find(({ matcher }) => matcher.test(input))

    if (cmd) {
      try {
        await cmd.handler(input.match(cmd.matcher))
      } catch (e) {
        this.onWriteConsoleOutput(`${colors.red('Error:')} %s`, e.message)
      }
    } else {
      this.onWriteConsoleOutput('Unknown command, try \'help\'')
    }
  }

  clearConsoleOutput () {
    this.screenConsoleOutputBox.setContent('')
    this.screenConsoleOutputBox.scrollTo(1)
  }

  onWriteConsoleOutput (...args) {
    this.screenConsoleOutputBox.pushLine(`${sprintf(...args)}`)
    this.screenConsoleOutputBox.scrollTo(this.screenConsoleOutputBox.getLines().length)
  }

  setTradeSizeAlertThreshold (size) {
    this.tradeSizeAlertThreshold = size
    this.updateStatus()
  }

  setTradeGroupSizeAlertThreshold (size) {
    this.groupSizeAlertThreshold = size
    this.updateStatus()
  }

  setLeftChartWindow (window) {
    this.leftChartWindow = window
    this.updatePriceCharts()
  }

  setRightChartWindow (window) {
    this.rightChartWindow = window
    this.updatePriceCharts()
  }

  setEMAPeriod (period) {
    this.emaPeriod = period
    this.updatePriceCharts()
  }

  setQuickOrderSize (size) {
    this.quickOrderSize = size
    this.updateStatus()
  }

  getQuickOrderSize () {
    return this.quickOrderSize
  }

  async submitOrder (o) {
    this.l.star('Submitting order: %s', o.toString())
    await this.ws.submitOrder(o)
    this.l.success('Order submitted')

    this.orderHistory.push(o)
    this.updateOrderLog()
  }

  updateOrderLog () {
    this.screenOrderLogBox.setContent(this.orderHistory.map(o => [
      `${(o.amount < 0 ? colors.red : colors.green)(o.toString())}`,
      colors.gray(moment(o.mtsCreate).fromNow())
    ].join(' ')).join('\n'))

    this.screenOrderLogBox.scrollTo(this.screenOrderLogBox.getLines().length)
    this.screen.render()
  }

  updatePositionStatus () {
    if (!(this.position || {}).basePrice) {
      this.screenPositionStatusBox.setContent('No Position Open')
    } else {
      const { basePrice, amount, pl, plPerc, liquidationPrice } = this.position
      const clBG = a => a < 0 ? colors.bgRed.black : colors.bgGreen.black
      const clFG = a => a < 0 ? colors.red : colors.green

      this.screenPositionStatusBox.setContent([
        clBG(+amount)(prepareAmount(amount)),
        '@',
        preparePrice(basePrice),
        clFG(+pl)(`(P/L ${prepareAmount(pl)} [${(plPerc * 100).toFixed(2)}%])`),
        `[liq ${preparePrice(liquidationPrice)}]`
      ].join(' '))
    }

    this.screen.render()
  }

  updateStatus () {
    const lastPrice = _isFinite(this.lastTradePrice)
      ? preparePrice(this.lastTradePrice)
      : '-'

    const pl = _isFinite(this.marginInfo.userPL)
      ? prepareAmount(this.marginInfo.userPL)
      : '-'

    const plCL = !_isFinite(+pl)
      ? colors.cyan
      : +pl === 0
        ? colors.bgMagenta.black
        : +pl > 0
          ? colors.bgGreen.black
          : colors.bgRed.black

    const marginBalance = _isFinite(this.marginInfo.marginBalance)
      ? prepareAmount(this.marginInfo.marginBalance)
      : '-'

    const marginNet = _isFinite(this.marginInfo.marginNet)
      ? prepareAmount(this.marginInfo.marginNet)
      : '-'

    const tradableBalance = _isFinite(+marginNet)
      ? prepareAmount(marginNet * this.maxLeverage)
      : '-'

    const statusContent = [
      `Trade Size Alert: ${this.tradeSizeAlertThreshold}`,
      `Trade Group Size Alert: ${this.groupSizeAlertThreshold}`,
      colors.bgMagenta.black(`Last Price: ${lastPrice}`),
      '',
      `Quick Order Size: ${this.quickOrderSize === 0 ? 'unset' : this.quickOrderSize}`,
      '',
      plCL(`Margin P/L: ${pl}`),
      `Margin Balance: ${marginBalance}`,
      `Margin Net: ${marginNet}`,
      colors.bgMagenta.black(`Tradable Balance: ${tradableBalance}`),
      '',
      `Min Trade Size: ${this.minTradeSize || '-'}`,
      `Max Leverage: ${this.maxLeverage ? this.maxLeverage.toFixed(1) : '-'}`
    ]

    if (!_isEmpty(this.primes)) {
      statusContent.push('')
      statusContent.push(colors.brightBlue('Prime rules:'))

      this.primes.forEach(({ type, threshold }) => {
        statusContent.push(`  ${colors.bgBrightBlue.black(`${type} ${threshold}`)}`)
      })
    }

    this.screenStatusBox.setContent(statusContent.join('\n'))
  }

  clearAutoStatus () {
    this.screenAutoStatus.setContent('Idle')
    this.screenAutoStatus.style.bg = 'transparent'
    this.screenAutoStatus.style.fg = 'white'

    if (this.autoStatusBlinkInterval) {
      clearInterval(this.autoStatusBlinkInterval)
      this.autoStatusBlinkInterval = null
    }

    this.screen.render()
  }

  setPrimedAutoStatus () {
    this.screenAutoStatus.setContent('PRIMED')
    this.screenAutoStatus.style.bg = 'transparent'
    this.screenAutoStatus.style.fg = 'white'

    if (this.autoStatusBlinkInterval) {
      clearInterval(this.autoStatusBlinkInterval)
    }

    this.autoStatusBlinkInterval = setInterval(() => {
      if (this.screenAutoStatus.style.bg === 'transparent') {
        this.screenAutoStatus.style.bg = 'yellow'
        this.screenAutoStatus.style.fg = 'black'
      } else {
        this.screenAutoStatus.style.bg = 'transparent'
        this.screenAutoStatus.style.fg = 'white'
      }

      this.screen.render()
    }, AUTO_STATUS_BLINK_INTERVAL_MS)
  }

  // Either updates the previous line if the amount sign matches, incrementing
  // the displayed trade count, or pushes a new line for the new amount sign.
  // The result is trades grouped by amount sign w/ count
  pushTradeBoxTrade (trade) {
    const { amount, price } = trade
    const cl = amount < 0
      ? amount < -1 * this.tradeSizeAlertThreshold
        ? colors.bgRed.black
        : colors.red
      : amount > this.tradeSizeAlertThreshold
        ? colors.bgGreen.black
        : colors.green

    const box = amount < 0
      ? this.screenLastSellGroupBox
      : this.screenLastBuyGroupBox

    const fmt = a => a < 0
      ? a < -1 * this.groupSizeAlertThreshold
        ? colors.bgRed.black
        : colors.red
      : a > this.groupSizeAlertThreshold
        ? colors.bgGreen.black
        : colors.green

    if (_isEmpty(box.getText()) || this.lastTradeAmount * amount < 0) {
      box.setContent(fmt(amount)(`${prepareAmount(amount)} ${USTAR} `))
    } else {
      const tokens = box.getText().split(' ')
      const prevAmount = +tokens[0]
      const prevCount = tokens[1].split('').length
      const stars = new Array(...(new Array(prevCount + 1))).map(() => USTAR).join('')
      const nextAmount = prevAmount + amount

      box.setContent(fmt(nextAmount)(`${prepareAmount(nextAmount)} ${stars} `))
    }

    if (amount < 0) {
      this.screenLastSellGroupBox.style.border.fg = 'red'
      this.screenLastBuyGroupBox.style.border.fg = 'white'
    } else {
      this.screenLastBuyGroupBox.style.border.fg = 'green'
      this.screenLastSellGroupBox.style.border.fg = 'white'
    }

    this.screenTradeBox.pushLine(`${cl(prepareAmount(amount))} @ ${preparePrice(price)}`)
    this.screenTradeBox.scrollTo(this.screenTradeBox.getLines().length)
    this.screen.render()
  }

  async connect (symbol) {
    if (this.symbol) {
      throw new Error(`Already connected for ${symbol}`)
    }

    this.symbol = symbol

    this.l.info('fetching margin info...')

    this.marginInfo = await this.rest.marginInfo()
    this.updateStatus()

    this.ws.onMarginInfoUpdate({}, (info) => {
      if (info.type !== 'base') {
        return
      }

      this.marginInfo = info
      this.updateStatus()
    })

    // TODO: Move/extract/refactor
    this.ws.onPositionSnapshot({}, (snapshot) => {
      this.position = snapshot.find(p => p.symbol === symbol)
      this.updatePositionStatus()
    })

    this.ws.onPositionNew({}, (position) => {
      if (position.symbol !== symbol) {
        return
      }

      this.position = position
      this.updatePositionStatus()
    })

    this.ws.onPositionUpdate({}, (position) => {
      if (position.symbol !== symbol) {
        return
      }

      this.position = position
      this.updatePositionStatus()
    })

    this.ws.onPositionClose({}, (position) => {
      if (position.symbol !== symbol) {
        return
      }

      this.position = {}
      this.updatePositionStatus()
    })

    this.l.info('fetching leverage info...')
    const res = await this.rest.conf(['pub:info:pair'])
    const [info] = res
    const marketInfo = info.find(l => l[0] === this.symbol.substring(1))

    if (!marketInfo) {
      throw new Error(`Failed to fetch market information for symbol ${symbol}`)
    }

    this.maxLeverage = 1 / marketInfo[1][8]
    this.minTradeSize = +marketInfo[1][3]
    this.quickOrderSize = this.minTradeSize

    this.updateStatus()
    this.l.info(
      'got max leverage of %f and min trade size of %f for market %s',
      this.maxLeverage.toFixed(1), this.minTradeSize, symbol
    )

    this.lws.info('connecting...')
    await this.ws.open()
    this.lws.success('connected!')

    await this.ws.auth()
    this.lws.success('authenticated!')

    const candleKey = `trade:1m:${symbol}`

    this.ws.onTradeEntry({ symbol }, this.onRecvTrade)
    this.ws.onCandle({ key: candleKey }, this.onRecvCandles)

    this.lws.info('subscribing to trades for %s...', symbol)
    await this.ws.subscribeTrades(symbol)
    this.lws.success('subscribed to trades for %s', symbol)
    this.lws.info('subscribing to 1min candles for %s...', symbol)
    await this.ws.subscribeCandles(candleKey)
    this.lws.success('subscribed to candles for %s', symbol)

    // TODO: Refactor
    setInterval(() => {
      this.ws.requestCalc([
        'margin_base',
        `margin_sym_${this.symbol}`,
        `position_${this.symbol}`
      ])
    }, 5 * 1000) // aggressive
  }

  async evaluatePrimes (trade) {
    const { amount } = trade
    let primeExecuted = false

    for (let i = this.primes.length - 1; i >= 0; i -= 1) {
      const prime = this.primes[i]
      const { type, threshold, amount: primeAmount, tif } = prime

      if (_isFinite(tif) && tif < Date.now()) {
        this.l.info('prime rule expired (%s threshold %s)', type, threshold)
        this.primes.splice(i, 1)
        continue
      }

      if (type === TYPES.size && (
        (threshold > 0 && amount >= threshold) ||
        (threshold < 0 && amount <= threshold)
      )) {
        this.l.star('prime rule triggered (%s threshold %s)', type, threshold)

        notifier.notify({
          title: 'Prime Trigger',
          message: sprintf(
            'Rule (%s) triggered\n%f %s %f', type, amount,
            threshold < 0 ? '<=' : '>=', threshold
          )
        })

        const orderAmount = _isFinite(primeAmount)
          ? primeAmount
          : threshold < 0
            ? -1 * this.quickOrderSize
            : this.quickOrderSize

        const o = new Order({
          symbol: this.symbol,
          type: Order.type.MARKET,
          amount: orderAmount
        })

        this.l.star('submitting order: %s', o.toString())

        await this.ws.submitOrder(o)

        primeExecuted = true
        break
      }
    }

    // Clear primes if one is triggered; maybe refactor, but if a prime executes
    // the reasoning behind the other primes is likely no longer valid. Very
    // opinionated, maybe make optional.
    if (primeExecuted) {
      this.primes = []
      this.updateStatus()
      this.clearAutoStatus()
    }
  }

  onRecvCandles (candle) {
    const candles = candle.length ? candle : [candle]

    for (let i = 0; i < candles.length; i += 1) {
      this.candles[candles[i].mts] = candles[i]
    }

    this.updatePriceCharts()
  }

  async onRecvTrade (trade) {
    this.pushTradeBoxTrade(trade)
    this.updateLastCandleClose(trade.price)
    this.updatePriceCharts()

    this.lastTradeAmount = trade.amount
    this.lastTradePrice = trade.price

    this.updateStatus()
    return this.evaluatePrimes(trade)
  }

  updateLastCandleClose (price) {
    const timestamps = Object.keys(this.candles)
    timestamps.sort((a, b) => +b - +a)
    const currMTS = timestamps[0]
    this.candles[currMTS].close = price
  }

  updatePriceCharts () {
    const timestamps = Object.keys(this.candles)
    timestamps.sort((a, b) => +a - +b)
    const timestampsLeft = timestamps.slice(-this.leftChartWindow)
    const timestampsRight = timestamps.slice(-this.rightChartWindow)

    const ema = new EMA([this.emaPeriod])

    timestamps.map((mts) => {
      ema.add(this.candles[mts].close)
    })

    const priceSeriesLeft = {
      title: 'Price',
      x: timestampsLeft.map(t => new Date(+t).toLocaleTimeString()),
      y: timestampsLeft.map(mts => this.candles[mts].close)
    }

    const emaSeriesLeft = {
      title: `EMA(${this.emaPeriod})`,
      x: timestampsLeft.map(t => new Date(+t).toLocaleTimeString()),
      y: ema._values.slice(-this.leftChartWindow),
      style: { line: 'blue' }
    }

    const priceSeriesRight = {
      title: 'Price',
      x: timestampsRight.map(t => new Date(+t).toLocaleTimeString()),
      y: timestampsRight.map(mts => this.candles[mts].close)
    }

    const emaSeriesRight = {
      title: `EMA(${this.emaPeriod})`,
      x: timestampsRight.map(t => new Date(+t).toLocaleTimeString()),
      y: ema._values.slice(-this.rightChartWindow),
      style: { line: 'blue' }
    }

    this.screenGraphLeft.options.minY = _min(priceSeriesLeft.y)
    this.screenGraphLeft.setData([
      priceSeriesLeft,
      emaSeriesLeft
    ])

    this.screenGraphRight.options.minY = _min(priceSeriesRight.y)
    this.screenGraphRight.setData([
      priceSeriesRight,
      emaSeriesRight
    ])

    this.screen.render()
  }
}

module.exports = Monitor