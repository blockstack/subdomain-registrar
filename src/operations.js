/* @flow */

import { config as bskConfig } from 'blockstack'
import { SERVER_GLOBALS } from './server'
import { makeZoneFile } from 'zone-file'
import logger from 'winston'
import fetch from 'node-fetch'
import { crypto } from 'bitcoinjs-lib'
import RIPEMD160 from 'ripemd160'

import {
  bufferCV,
  bufferCVFromString,
  getAddressFromPrivateKey,
  makeContractCall,
  TransactionVersion
} from '@stacks/transactions'

export type SubdomainOp = {
  owner: string,
  sequenceNumber: number,
  zonefile: string,
  subdomainName: string,
  signature: string,
};

const deployedName = 'bns'

const ZONEFILE_TEMPLATE = '{$origin}\n{$ttl}\n{txt}{uri}'

// reconfigure obtaining consensus hash
bskConfig.network.getConsensusHash = async function () {
  const httpResponse = await fetch('https://core.blockstack.org/v1/info')
  const jsonResponse = await httpResponse.json()
  const lastBlockSeen = SERVER_GLOBALS.lastSeenBlockHeight

  if (jsonResponse.last_block_processed + 10 < lastBlockSeen) {
    logger.error('core.blockstack.org is >10 blocks behind the chain tip', {
      msgType: 'stale_core',
      lastBlockSeen,
      coreLastProcessed: jsonResponse.last_block_processed
    })
    throw new Error('core.blockstack.org is >10 blocks behind the chain tip')
  }

  const consensusHash = jsonResponse.consensus

  logger.info(`Obtained consensus hash ${consensusHash}`, {
    msgType: 'consensus_hash',
    consensusHash
  })

  return consensusHash
}
export function destructZonefile(zonefile: string) {
  const encodedZonefile = Buffer.from(zonefile).toString('base64')
  // we pack into 250 byte strings -- the entry "zf99=" eliminates 5 useful bytes,
  // and the max is 255.
  const pieces = 1 + Math.floor(encodedZonefile.length / 250)
  const destructed = []
  for (let i = 0; i < pieces; i++) {
    const startIndex = i * 250
    const currentPiece = encodedZonefile.slice(startIndex, startIndex + 250)
    if (currentPiece.length > 0) {
      destructed.push(currentPiece)
    }
  }
  return destructed
}

export function subdomainOpToZFPieces(operation: SubdomainOp) {
  const destructedZonefile = destructZonefile(operation.zonefile)
  const txt = [
    `owner=${operation.owner}`,
    `seqn=${operation.sequenceNumber}`,
    `parts=${destructedZonefile.length}`
  ]
  destructedZonefile.forEach((zfPart, ix) => txt.push(`zf${ix}=${zfPart}`))

  if (operation.signature) {
    txt.push(`sig=${operation.signature}`)
  }

  return {
    name: operation.subdomainName,
    txt
  }
}

export function makeUpdateZonefile(
  domainName: string,
  uriEntries: Array<{
    name: string,
    target: string,
    priority: number,
    weight: number,
  }>,
  updates: Array<SubdomainOp>,
  maxZonefileBytes: number
) {
  const subdomainRecs = []
  const zonefileObject = {
    $origin: domainName,
    $ttl: 3600,
    uri: uriEntries,
    txt: subdomainRecs
  }
  const submitted = []

  logger.debug('Constructing zonefile: ')
  logger.debug(zonefileObject)

  let outZonefile = makeZoneFile(zonefileObject, ZONEFILE_TEMPLATE)
  for (let i = 0; i < updates.length; i++) {
    subdomainRecs.push(subdomainOpToZFPieces(updates[i]))
    const newZonefile = makeZoneFile(zonefileObject, ZONEFILE_TEMPLATE)
    if (newZonefile.length < maxZonefileBytes) {
      outZonefile = newZonefile
      submitted.push(updates[i].subdomainName)
    } else {
      break // zonefile got too long, use last generated one!
    }
  }

  return {
    zonefile: outZonefile,
    submitted
  }
}

async function nameUpdate(
  namespace: string,
  name: string,
  attachment: string,
  pkey: string,
  network
) {
  const deployedTo = bskConfig.network.version === TransactionVersion.Mainnet ? 'SP000000000000000000002Q6VF78' : 'ST000000000000000000002AMW42H'
  const txOptions = {
    contractAddress: deployedTo,
    contractName: deployedName,
    functionName: 'name-update',
    functionArgs: [
      bufferCVFromString(namespace),
      bufferCVFromString(name),
      bufferCV(hash160(Buffer.from(attachment)))
    ],
    senderKey: pkey,
    validateWithAbi: true,
    network: network
  }

  const transaction = await makeContractCall(txOptions)

  return transaction.serialize().toString('hex')
}

export async function submitUpdate(
  domainName: string,
  zonefile: string,
  ownerKey: string,
  paymentKey: string
) {
  const ownerAddress = getAddressFromPrivateKey(
    ownerKey,
    bskConfig.network.version
  )

  const deconstruct = domainName.split('.')
  if (deconstruct.length != 2) {
    throw new Error('Invalid domain name')
  }

  const nameInfoUrl = bskConfig.network.coreApiUrl + '/v1/names/' + domainName
  const nameInfoRequest = await fetch(nameInfoUrl)
  const nameInfo = await nameInfoRequest.json()

  if (nameInfo.address !== ownerAddress) {
    throw new Error(
      `Domain name ${domainName} not owned by address ${ownerAddress}`
    )
  } // owner validated

  const name = deconstruct[0]
  const namespace = deconstruct[1]

  const txHex = await nameUpdate(
    namespace,
    name,
    zonefile,
    paymentKey,
    bskConfig.network
  )

  const atch_hex = Buffer.from(zonefile).toString('hex')
  const body = {
    attachment: atch_hex,
    tx: txHex
  }

  try {
    const result = await fetch(
      bskConfig.network.getBroadcastApiUrl(),
      {
        method: 'post',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' }
      }
    )
    const txHash = await result.json()
    return txHash
  } catch (err) {
    throw new Error('Error post transaction: ' + err.message)
  }
}

export async function updateGlobalBlockHeight(): Promise<void> {
  try {
    const httpRequest = await fetch(bskConfig.network.getInfoUrl())
    const { status } = httpRequest
    const response = await httpRequest.json()
    if (status == 200) {
      const blockHeight = response.burn_block_height
      if (SERVER_GLOBALS.lastSeenBlockHeight > blockHeight) {
        throw new Error(
          `Last seen block ${SERVER_GLOBALS.lastSeenBlockHeight} is greater than returned block height ${blockHeight}`
        )
      }
      SERVER_GLOBALS.lastSeenBlockHeight = blockHeight
    } else {
      throw new Error(response.message)
    }
  } catch (error) {
    throw new Error('Error fetching block height.')
  }
}

/* eslint-disable */
async function broadcastZonefile(zonefile: string) {
  const body = {
    zonefile: zonefile
  }
  try {
    const result = await fetch(bskConfig.network.coreApiUrl + '/v1/zonefile', {
      method: 'post',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' }
    })
    console.log('status code', result.status)
    const txHash = await result.json()
    console.log('zone file tx hash', txHash)
    return txHash
  } catch (error) {
    throw new Error(
      'Failed to broadcast zonefile.'
    )
  }
}
/* eslint-disable */

export async function checkTransactions(
  txs: Array<{ txHash: string, zonefile: string, blockHeight: number }>
): Promise<Array<{ txHash: string, status: boolean, blockHeight: number }>> {
  await updateGlobalBlockHeight()

  const blockHeight = SERVER_GLOBALS.lastSeenBlockHeight

  return await Promise.all(
    txs.map(async (tx) => {
      if (!tx.blockHeight || tx.blockHeight <= 0) {
        // const txInfo = await bskConfig.network.getTransactionInfo(tx.txHash)
        const url = new URL(
          bskConfig.network.coreApiUrl + `/extended/v1/tx/${tx.txHash}`
        )
        const httpRequest = await fetch(url)
        const txInfo = await httpRequest.json()

        if (!txInfo.block_height) {
          logger.info('Could not get block_height, probably unconfirmed.', {
            msgType: 'unconfirmed',
            txid: tx.txHash
          })
          return { txHash: tx.txHash, status: false, blockHeight: -1 }
        } else {
          tx.blockHeight = txInfo.block_height
        }
      }

      if (tx.blockHeight + 7 > blockHeight) {
        logger.debug(
          `block_height for ${tx.txHash}: ${tx.blockHeight} --- has ${1 + blockHeight - tx.blockHeight
          } confirmations`
        )
        return {
          txHash: tx.txHash,
          status: false,
          blockHeight: tx.blockHeight
        }
      } else {
        try {
          if (
            bskConfig.network.blockstackAPIUrl === 'https://core.blockstack.org'
          ) {
            await directlyPublishZonefile(tx.zonefile)
            // this is horrible. I know. but the reasons have to do with load balancing
            // on node.blockstack.org and Atlas peering.
            await directlyPublishZonefile(tx.zonefile)
            return {
              txHash: tx.txHash,
              status: true,
              blockHeight: tx.blockHeight
            }
          } else {
            // await broadcastZonefile(tx.zonefile) //todo 
            return {
              txHash: tx.txHash,
              status: true,
              blockHeight: tx.blockHeight
            }
          }
        } catch (err) {
          logger.error(`Error publishing zonefile for tx ${tx.txHash}: ${err}`)
          return {
            txHash: tx.txHash,
            status: false,
            blockHeight: tx.blockHeight
          }
        }
      }
    })
  )
}

export function hash160(input: Buffer) {
  const sha256 = crypto.sha256(input)
  return new RIPEMD160().update(sha256).digest()
}

// this is a hack -- this is a stand-in while we roll out support for
//   publishing zonefiles via core.blockstack
export async function directlyPublishZonefile(
  zonefile: string
): Promise<boolean> {
  // speak directly to node.blockstack

  const b64Zonefile = Buffer.from(zonefile).toString('base64')

  const postData =
    '<?xml version=\'1.0\'?>' +
    '<methodCall><methodName>put_zonefiles</methodName>' +
    `<params><param><array><data><value>
         <string>${b64Zonefile}</string></value>
         </data></array></param></params>` +
    '</methodCall>'
  const resp = await fetch('https://node.blockstack.org:6263/RPC2', {
    method: 'POST',
    body: postData
  })

  const respText = await resp.text()

  if (!(resp.status >= 200 && resp.status <= 299)) {
    logger.error(
      `Publish zonefile error: Response code from node.blockstack: ${resp.status}`
    )
    logger.error(
      `Publish zonefile error: Response from node.blockstack: ${respText}`
    )
    throw new Error(
      'Failed to publish zonefile. Bad response from node.blockstack'
    )
  }

  const start = respText.indexOf('<string>') + '<string>'.length
  const stop = respText.indexOf('</string>')
  const dataResp = respText.slice(start, stop)
  let jsonResp
  try {
    jsonResp = JSON.parse(dataResp)
  } catch (err) {
    logger.error(
      `Failed to parse JSON response from node.blockstack: ${respText}`
    )
    throw err
  }

  if ('error' in jsonResp) {
    logger.error(`Error in publishing zonefile: ${JSON.stringify(jsonResp)}`)
    throw new Error(jsonResp.error)
  }

  if (!jsonResp.saved || jsonResp.saved.length < 1) {
    throw new Error('Invalid "saved" response from node.blockstack')
  }

  if (jsonResp.saved[0] === 1) {
    return true
  } else if (jsonResp.saved[0] === 0) {
    throw new Error('Zonefile not saved')
  }

  throw new Error('Invalid "saved" response from node.blockstack')
}
