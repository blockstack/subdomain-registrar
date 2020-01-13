import { config as bskConfig, validateProofs, resolveZoneFileToProfile } from 'blockstack'

import logger from 'winston'

export async function isSubdomainRegistered(fullyQualifiedAddress: String) {
  try {
    const nameInfo = await bskConfig.network.getNameInfo(fullyQualifiedAddress)
    return (nameInfo.status === 'registered_subdomain')
  } catch (err) {
    if (err.message === 'Name not found') {
      return false
    } else if (err.message === 'Bad response status: 500') {
      return false // currently, the blockstack api returns 500 on subdomain lookup errors.
    } else {
      throw err
    }
  }
}

export function validlySignedUpdate() {
  throw new Error('Not implemented')
}

export function checkProofs(owner, zonefile) {
  return resolveZoneFileToProfile(zonefile, owner)
    .then((profile) => validateProofs(profile, owner))
    .then((proofs) => proofs.filter(x => x.valid))
}

export async function isRegistrationValid(
  subdomainName: String, domainName: String,
  owner: String, sequenceNumber: Number, checkCore: boolean) {
  // currently, only support *new* subdomains
  if (sequenceNumber !== 0) {
    logger.debug(`seqn: ${sequenceNumber} failed validation`)
    return false
  }
  // owner should be a bitcoin address
  const btcRegex = /^[132mn][a-km-zA-HJ-NP-Z1-9]{25,34}$/
  if (!btcRegex.test(owner)) {
    logger.debug(`owner: ${owner} failed validation`)
    return false
  }
  // subdomain name should be a legal name
  const subdomainRegex = /^[a-z0-9\-_+]{1,37}$/
  if (!subdomainRegex.test(subdomainName)) {
    logger.debug(`subdomainName: ${subdomainName} failed validation`)
    return false
  }
  if (!checkCore) {
    return true
  }

  // shouldn't already exist
  try {
    const isRegistered = await isSubdomainRegistered(`${subdomainName}.${domainName}`)
    if (isRegistered) {
      logger.warn(`${subdomainName}.${domainName} already exists`)
    }
    return !isRegistered
  } catch (e) {
    logger.error(e)
    return false
  }
}
