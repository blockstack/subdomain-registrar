import { PAYER_SK, OWNER_SK, DEVELOP_DOMAIN, ADMIN_PASSWORD } from './developmode'
import { config as bskConfig } from 'blockstack'
import winston from 'winston'
import fs from 'fs'

const adminPassword = process.env.ADMIN_PASSWORD || ADMIN_PASSWORD

const configDevelopDefaults = {
  winstonConsoleTransport: {
    level: 'info',
    handleExceptions: false,
    timestamp: true,
    stringify: true,
    colorize: true,
    json: false
  },
  domainName: DEVELOP_DOMAIN,
  ownerKey: OWNER_SK,
  paymentKey: PAYER_SK,
  batchDelayPeriod: 0.5,
  checkTransactionPeriod: 0.1,
  dbLocation: '/tmp/subdomain_registrar.db',
  adminPassword,
  domainUri: 'file:///tmp/whatever',
  resolverUri: 'http://localhost:3000',
  zonefileSize: 40960,
  development: false,
  port: 3000,
  regtest: true,
  ipLimit: 0,
  apiKeys: [],
  proofsRequired: 0,
  disableRegistrationsWithoutKey: false,
  checkCoreOnBatching: true,
  prometheus: { start: false, port: 0 }
}

const configDefaults = {
  winstonConsoleTransport: {
    level: 'info',
    handleExceptions: false,
    timestamp: true,
    stringify: true,
    colorize: true,
    json: false
  },
  domainName: null,
  ownerKey: null,
  paymentKey: null,
  // submit batch (if has updates) every 15 minutes
  batchDelayPeriod: 15,
  // check if zonefiles can be broadcasted every 5 minutes
  checkTransactionPeriod: 5,
  zonefileSize: 40960,
  dbLocation: 'subdomain_registrar.db',
  adminPassword,
  domainUri: 'https://registrar.whatever.com',
  resolverUri: false,
  port: 3000,
  ipLimit: 1,
  apiKeys: [],
  proofsRequired: 0,
  disableRegistrationsWithoutKey: false,
  checkCoreOnBatching: true,
  nameMinLength: 1,
  prometheus: { start: false, port: 0 },
  minBatchSize: 1
}


export function getConfig() {
  let config = Object.assign({}, configDefaults)
  if (process.env.BSK_SUBDOMAIN_DEVELOP) {
    config = Object.assign({}, configDevelopDefaults)
    config.development = true
  }
  if (process.env.BSK_SUBDOMAIN_REGTEST) {
    config = Object.assign({}, {
      ...configDevelopDefaults,
      domainName: process.env.OWNER_NAME || configDevelopDefaults.DEVELOP_DOMAIN,
      ownerKey: process.env.OWNER_KEY || configDevelopDefaults.OWNER_SK,
      paymentKey: process.env.PAYMENT_KEY || configDevelopDefaults.PAYER_SK
    })
  }
  if (process.env.BSK_SUBDOMAIN_CONFIG) {
    const configFile = process.env.BSK_SUBDOMAIN_CONFIG
    Object.assign(config, JSON.parse(fs.readFileSync(configFile)))
  }
  if (process.env.BSK_SUBDOMAIN_PAYMENT_KEY) {
    config.paymentKey = process.env.BSK_SUBDOMAIN_PAYMENT_KEY
  }
  if (process.env.BSK_SUBDOMAIN_OWNER_KEY) {
    config.ownerKey = process.env.BSK_SUBDOMAIN_OWNER_KEY
  }
  if (process.env.BSK_SUBDOMAIN_PROMETHEUS_PORT) {
    config.prometheus = { start: true, port: parseInt(process.env.BSK_SUBDOMAIN_PROMETHEUS_PORT) }
  }
  if (process.env.BLOCKSTACK_API_URL) {
    bskConfig.network.blockstackAPIUrl = process.env.BLOCKSTACK_API_URL
    bskConfig.network.coreApiUrl = process.env.BLOCKSTACK_API_URL
  }

  config.winstonConfig = {
    transports: [
      new winston.transports.Console(config.winstonConsoleTransport)
    ]
  }

  return config
}
