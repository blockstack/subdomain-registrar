import { config as bskConfig, network as bskNetwork } from 'blockstack'
import logger from 'winston'
import { exec } from 'child_process'
import { StacksMocknet } from '@stacks/network'

export const PAYER_SK = 'bb68eda988e768132bc6c7ca73a87fb9b0918e9a38d3618b74099be25f7cab7d01'
export const OWNER_SK = '8f87d1ea26d03259371675ea3bd31231b67c5df0012c205c154764a124f5b8fe01'
export const DEVELOP_DOMAIN = 'foo.id'
export const ADMIN_PASSWORD = 'tester129'

function pExec(cmd) {
  return new Promise(
    (resolve, reject) => {
      exec(cmd, function (err, stdout, stderr) {
        if (err) {
          reject(err)
        } else {
          resolve(stdout, stderr)
        }
      })
    })
}

export function configureRegtest() {
  bskConfig.network = bskNetwork.defaults.LOCAL_REGTEST
  bskConfig.network = new StacksMocknet() //for development case
  if (process.env.BLOCKSTACK_TEST_CLIENT_RPC_PORT) {
    const port = process.env.BLOCKSTACK_TEST_CLIENT_RPC_PORT
    bskConfig.network.blockstackAPIUrl = `http://localhost:${port}`
  }
}

export function initializeBlockstackCore(forceRestart: ?Boolean = false,
  dockerTag: ?String = null) {
  if (!dockerTag) {
    dockerTag = 'blockstack-regtester'
  }
  logger.info('Initializing regtest environment')
  const priorVersionRunning = pExec('docker ps | grep -q test-bsk-core')
    .then(() => {
      logger.info('Prior docker container running.')
      if (forceRestart) {
        logger.info('Forcing restart')
        return pExec('docker stop test-bsk-core ; docker rm test-bsk-core ;' +
          ' rm -rf /tmp/.blockstack_int_test')
          .then(() => false)
          .catch((err) => {
            logger.warn('Couldnt stop a previous running test-bsk-core -- might not have been running.')
            logger.warn(err)
            return false
          })
      } else {
        return true
      }
    })
    .catch(() => false)

  return priorVersionRunning
    .then((running) => {
      if (running) {
        return true
      } else {
        return pExec('docker run --name test-bsk-core -dt -p 16268:16268 -p 18332:18332 ' +
          '-e BLOCKSTACK_TEST_CLIENT_RPC_PORT=16268 ' +
          '-e BLOCKSTACK_TEST_CLIENT_BIND=0.0.0.0 ' +
          '-e BLOCKSTACK_TEST_BITCOIND_ALLOWIP=172.17.0.0/16 ' +
          `${dockerTag} ` +
          'blockstack-test-scenario --interactive 2 ' +
          'blockstack_integration_tests.scenarios.portal_test_env')
          .then(() => {
            logger.info('Started regtest container, waiting until initialized')
            return pExec('docker logs -f test-bsk-core | grep -q inished')
          })
      }
    })
}

export function shutdownBlockstackCore() {
  return pExec('docker stop test-bsk-core')
}

