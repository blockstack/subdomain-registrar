import cors from 'cors'
import express from 'express'
import bodyParser from 'body-parser'
import logger from 'winston'

import { SubdomainServer } from './server'

import { createMiddleware as createPrometheusMiddleware } from '@promster/express'
import { createServer } from '@promster/server'

const HEADERS = { 'Content-Type': 'application/json' }

export function makeHTTPServer(config) {
  const app = express()
  const server = new SubdomainServer(config)

  if (config.prometheus && config.prometheus.start && config.prometheus.port) {
    app.use(createPrometheusMiddleware({
      app,
      options: {
        normalizePath: (path) => {
          if (path.startsWith('/v1/names')) {
            return '/v1/names'
          }
          if (path.startsWith('/status')) {
            return '/status'
          }
          if (path.startsWith('/v1/names')) {
            return '/list'
          }
          return path
        }
      }
    }))
    const port = config.prometheus.port

    // Create `/metrics` endpoint on separate server
    createServer({ port }).then(() => console.log(`@promster/server started on port ${port}.`))
  }

  app.use(cors())
  app.use(bodyParser.json())

  app.get('/index', (req, res) => {
    res.writeHead(200, HEADERS)
    res.write(JSON.stringify(
      { status: true,
        domainName: config.domainName }))
    res.end()
  })

  app.post('/register', (req, res) => {
    const requestJSON = req.body
    if (!requestJSON) {
      res.writeHead(400, HEADERS)
      res.write(JSON.stringify(
        { status: false,
          message: 'Failed to parse your registration request: expected JSON' }))
      res.end()
      return
    }

    // note: x-real-ip is *only* trust-worthy when running behind a
    //   proxy that the registrar controls!
    const ipAddress = req.headers['x-real-ip'] || req.connection.remoteAddress
    const authorization = req.headers.authorization || ''

    server.queueRegistration(requestJSON.name,
                             requestJSON.owner_address,
                             0,
                             requestJSON.zonefile,
                             ipAddress,
                             authorization)
      .then(() => {
        res.writeHead(202, HEADERS)
        res.write(JSON.stringify(
          { status: true,
            message: 'Your subdomain registration was received, and will '
            + 'be included in the blockchain soon.' }))
        res.end()
      })
      .catch((err) => {
        logger.error(err)
        let message = 'Failed to validate your registration request.'
        let code = 409
        if (err.message.startsWith('Proof')) {
          message = err.message
        }
        if (err.message.startsWith('NameLength:')) {
          code = 400
        }
        res.writeHead(code, HEADERS)
        res.write(JSON.stringify(
          { status: false,
            message }))
        res.end()
      })
  })

  app.post('/issue_batch/', (req, res) => {
    const authHeader = req.headers.authorization
    if (!authHeader || authHeader !== `bearer ${config.adminPassword}`) {
      res.writeHead(401, HEADERS)
      res.write(JSON.stringify(
        { status: false,
          message: 'Unauthorized' }))
      res.end()
    } else {
      server.submitBatch()
        .catch(() => logger.error('Failed to broadcast batch.'))
      res.writeHead(202, HEADERS)
      res.write(JSON.stringify(
        {
          status: true,
          message: 'Starting batch.'
        }))
      res.end()
    }
  })

  app.post('/check_zonefiles/', (req, res) => {
    const authHeader = req.headers.authorization
    if (!authHeader || authHeader !== `bearer ${config.adminPassword}`) {
      res.writeHead(401, HEADERS)
      res.write(JSON.stringify(
        { status: false,
          message: 'Unauthorized' }))
      res.end()
    } else {
      server.checkZonefiles()
        .catch(() => logger.error('Failed to check our zonefiles.'))
      res.writeHead(202, HEADERS)
      res.write(JSON.stringify(
        {
          status: true,
          message: 'Checking zonefiles.'
        }))
      res.end()
    }
  })

  app.get('/status/:subdomain', (req, res) => {
    server.getSubdomainStatus(req.params.subdomain)
      .then((status) => {
        if (status.statusCode) {
          res.writeHead(status.statusCode, HEADERS)
        } else {
          res.writeHead(200, HEADERS)
        }
        res.write(JSON.stringify(status))
        res.end()
      })
      .catch((e) => {
        logger.error(e)
        res.writeHead(501, HEADERS)
        res.write(JSON.stringify(
          { status: false,
            message: 'There was an error processing your request.' }))
        res.end()
      })
  })

  app.get('/v1/names/:fullyQualified', (req, res) => {
    server.getSubdomainInfo(req.params.fullyQualified)
      .catch(error => {
        logger.error(error)
        return { message: { error: 'Error processing request',
                            status: false },
                 statusCode: 400 }
      })
      .then(infoResponse => {
        res.writeHead(infoResponse.statusCode, HEADERS)
        res.write(JSON.stringify(
          infoResponse.message))
        res.end()
      })
  })

  app.get('/list/:iterator', (req, res) => {
    // iterator must be a reasonably-sized finite positive integer
    return Promise.resolve().then(() => {
      const iterator = req.params.iterator
      if (!iterator.match(/^[0-9]{1,10}$/)) {
        logger.warn('List iteratotr must be a reasonably-sized positive integer')
        return { message: { error: 'Iterator must be a reasonably-sized positive integer' },
                 statusCode: 400 }
      }
      return server.listSubdomainRecords(parseInt(iterator))
    })
      .catch((e) => {
        logger.error(e)
        return { message: { error: 'Error processing request',
                            status: false },
                 statusCode: 400 }
      })
      .then((response) => {
        res.writeHead(response.statusCode, HEADERS)
        res.write(JSON.stringify(response.message))
        res.end()
      })
  })

  const zonefileDelay = Math.min(2147483647,
                                 Math.floor(60000 * config.checkTransactionPeriod))
  const batchDelay = Math.min(2147483647,
                              Math.floor(60000 * config.batchDelayPeriod))

  return server.initializeServer()
    .then(() => {
      // schedule timers
      setInterval(() => {
        logger.debug('Waking up to broadcast a batch (UPDATE tx).')
        server.submitBatch()
          .catch(() => logger.error('Failed to broadcast batch.'))
      }, batchDelay)
      setInterval(() => {
        logger.debug('Waking up to check transaction statuses.')
        server.checkZonefiles()
          .catch(() => logger.error('Failed to check zonefile transaction status.'))
      }, zonefileDelay)
    })
    .then(() => app)
}
