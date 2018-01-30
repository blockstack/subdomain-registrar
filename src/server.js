import { makeUpdateZonefile, submitUpdate, checkTransactions } from './operations'
import { isRegistrationValid } from './lookups'
import sqlite3 from 'sqlite3'

const CREATE_QUEUE = `CREATE TABLE subdomain_queue (
index INTEGER PRIMARY KEY,
subdomainName TEXT NOT NULL,
owner TEXT NOT NULL,
sequenceNumber TEXT NOT NULL,
zonefile TEXT NOT NULL,
status TEXT NOT NULL,
status_more TEXT,
received_ts DATETIME DEFAULT CURRENT_TIMESTAMP
);`

const CREATE_QUEUE_INDEX = `CREATE INDEX subdomain_queue_index ON
subdomain_queue (subdomainName);`

const CREATE_MYZONEFILE_BACKUPS = `CREATE TABLE subdomain_zonefile_backups (
index INTEGER PRIMARY KEY,
zonefile TEXT NOT NULL,
timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);`

const CREATE_TRANSACTIONS_TRACKED = `CREATE TABLE transactions_tracked (
index INTEGER PRIMARY KEY,
txHash TEXT NOT NULL,
zonefile TEXT NOT NULL
);`


function dbRun(db: Object, cmd: String, args?: Array) {
  if (!args) {
    args = []
  }
  return new Promise((resolve, reject) => {
    db.run(cmd, args, (err) => {
      if (err) {
        reject(err)
      } else {
        resolve()
      }
    })
  })
}

function dbAll(db: Object, cmd: String, args?: Array) {
  if (!args) {
    args = []
  }
  return new Promise((resolve, reject) => {
    db.all(cmd, args, (err, rows) => {
      if (err) {
        reject(err)
      } else {
        resolve(rows)
      }
    })
  })
}

export class SubdomainServer {
  constructor(config: {domainName: String, ownerKey: String,
                       paymentKey: String, logger: Object,
                       dbLocation: String}) {
    this.logger = config.logger
    this.domainName = config.domainName
    this.ownerKey = config.ownerKey
    this.paymentKey = config.paymentKey
    this.dbLocation = config.dbLocation
  }

  initializeServer() {
    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(this.dbLocation, sqlite3.OPEN_READWRITE, (errOpen) => {
        if (errOpen) {
          this.logger.warn(`No database found ${this.dbLocation}, creating`)
          this.db = new sqlite3.Database(
            this.dbLocation, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (errCreate) => {
              if (errCreate) {
                reject(`Failed to load database ${this.dbLocation}`)
              } else {
                this.logger.warn('Creating tables...')
                this.createTables()
                  .then(() => resolve())
              }
            })
        } else {
          resolve()
        }
      })
    })
  }

  createTables() {
    const toCreate = [CREATE_QUEUE, CREATE_QUEUE_INDEX, CREATE_MYZONEFILE_BACKUPS,
                      CREATE_TRANSACTIONS_TRACKED]
    return dbRun(this.db, toCreate.join(' \n'))
  }

  queueRegistration(subdomainName, owner, sequenceNumber, zonefile) {
    return this.isSubdomainInQueue(subdomainName)
      .then((inQueue) => {
        if (inQueue) {
          throw new Error('Subdomain operation already queued for this name.')
        }
        return isRegistrationValid(
          subdomainName, this.domainName, owner, sequenceNumber, zonefile)
      })
      .then((valid) => {
        if (!valid) {
          throw new Error('Requested subdomain operation is invalid.')
        }
        return new Promise((resolve, reject) => {
          this.lock.writeLock((release) => {
            const dbCmd = 'INSERT INTO subdomain_queue ' +
                  '(subdomainName, owner, sequenceNumber, zonefile, status) VALUES ?, ?, ?, ?, ?'
            const dbArgs = [subdomainName, owner, sequenceNumber, zonefile, 'received']
            dbRun(this.db, dbCmd, dbArgs)
              .then(() => resolve())
              .catch((err) => reject(err))
              .finally(release)
          })
        })
      })
  }

  getSubdomainStatus(subdomainName: String) {
    const lookup = 'SELECT status, status_more FROM subdomain_queue' +
          ' WHERE subdomainName = ? ORDER BY index DESC LIMIT 1'
    return dbAll(this.db, lookup, [subdomainName])
      .then((rows) => {
        if (rows.length > 0) {
          return rows[0]
        } else {
          return { status: 'not_queued' }
        }
      })
  }

  isSubdomainInQueue(subdomainName: String) {
    this.getSubdomainStatus(subdomainName)
      .then(status => (status.status !== 'not_queued'))
  }

  backupZonefile(zonefile: String) {
    return dbRun(this.db, 'INSERT INTO subdomain_zonefile_backups (zonefile) VALUES ?',
                 [zonefile])
  }

  addTransactionToTrack(txHash: String, zonefile: String) {
    return dbRun(this.db, 'INSERT INTO transactions_tracked (txHash, zonefile) VALUES ?, ?',
                 [txHash, zonefile])
      .then(() => txHash)
  }

  updateQueueStatus(namesSubmitted: Array<String>, txHash: String) {
    const cmd = 'UPDATE subdomain_queue SET status = ?, status_more = ? WHERE subdomainName = ?'
    return Promise.all(namesSubmitted.map(
      name => dbRun(this.db, cmd, ['submitted', txHash, name])))
      .then(() => txHash)
  }

  markTransactionsComplete(txStatuses: Array<{txHash: String}>) {
    const cmd = 'DROP FROM transactions_tracked WHERE txHash = ?'
    return Promise.all(txStatuses.map(
      txHash => dbRun(this.db, cmd, [txHash])))
  }

  fetchQueue() {
    const cmd = 'SELECT subdomainName, owner, sequenceNumber, zonefile, signature' +
          ' FROM subdomain_queue WHERE status = "received"'
    return dbAll(this.db, cmd)
  }

  submitBatch() {
    return new Promise((resolve) => {
      this.lock.writeLock((release) => {
        this.fetchQueue()
          .then(queue => {
            const update = makeUpdateZonefile(this.domainName, queue, 4096)
            const zonefile = update.zonefile
            const updatedFromQueue = update.submitted
            return this.backupZonefile(zonefile)
              .then(() => submitUpdate(this.domainName, zonefile,
                                       this.ownerKey, this.paymentKey))
              .then((txHash) => this.updateQueueStatus(updatedFromQueue, txHash))
              .then((txHash) => this.addTransactionToTrack(txHash, zonefile))
          })
          .then(txHash => resolve(txHash))
          .finally(() => release())
      }, { timeout: 1,
           timeoutCallback: () => {
             throw new Error('Failed to obtain lock')
           }
         })
    })
  }

  checkZonefiles() {
    return dbAll(this.db, 'SELECT txHash, zonefile FROM transactions_tracked')
      .then(entries => checkTransactions(entries))
      .then(txStatuses => this.markTransactionsComplete(
        txStatuses.filter(x => x.status)))
      .catch((err) => {
        throw new Error(`Failed to check transaction status: ${err}`)
      })
  }

  shutdown() {
    return new Promise((resolve, reject) => {
      this.db.close((err) => {
        if (err) {
          reject(err)
        } else {
          resolve()
        }
      })
      this.db = undefined
    })
  }
}
