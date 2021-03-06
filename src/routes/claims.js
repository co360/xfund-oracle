require("dotenv").config()
const express = require("express")
const sigUtil = require("eth-sig-util")
const jwt = require("jsonwebtoken")
const Web3 = require("web3")
const { getUnclaimedEmissionsForValidatorId } = require("../db/emissions/queries")
const {
  getClaimTicketByTicket,
  getAllClaimTickets,
  getClaimTicketByMainchainTx,
  getClaimTicketsByAddressAndMcTx,
  getAllClaimTicketsByAddress,
  getClaimTicketsByStatus,
  getClaimTicketByMainchainTxAndEthAddr,
  getLastNonce,
  getClaimTicketsByAddressAndStatus,
  getClaimTicketById,
} = require("../db/claimTickets/queries")
const {
  insertClaimTicket,
  updateClaimTicketWithEthTx,
  updateClaimTicketWithTicket,
} = require("../db/claimTickets/update")
const { getBySelfDelegatorAddress } = require("../db/validators/queries")
const { updateMemoKey } = require("../db/memoKeys/update")
const { getMemoKey } = require("../db/memoKeys/queries")
const { getTx } = require("../chains/mainchain")
const { validateClaimTx } = require("../tx/claim")
const { generateClaimTicket } = require("../chains/eth")
const {
  DEFAULT_JSON_RESPONSE,
  STATUS_CODES,
  errorCodeLookup,
  isValidClaimStatus,
  claimStatusLookup,
} = require("../common/utils/constants")
const { jwtiseTicket, jwtiseMemo, checkBech32Address } = require("../crypto/utils")

const {
  xFundSigDomain,
  xFundSigTxData,
  xFundSigDomainData,
  TICKET_CLAIM_STATUS,
} = require("../common/utils/constants")

const { JWT_SHARED_SECRET } = process.env

const router = express.Router()

const processClaimResult = (res) => {
  const results = []

  for (let i = 0; i < res.length; i += 1) {
    const valDataVals = res[i].dataValues
    const ticketJson = JSON.parse(valDataVals.ticket)

    let claimTicket
    if (ticketJson) {
      claimTicket = jwtiseTicket(
        ticketJson.signature,
        valDataVals.amount,
        valDataVals.nonce,
        valDataVals.ethAddress,
      )
    }

    const v = {
      moniker: valDataVals.validator.moniker,
      operator_address: valDataVals.validator.operatorAddress,
      self_delegate_address: valDataVals.validator.selfDelegateAddress,
      claim_ticket: claimTicket,
      claim_status: valDataVals.claimStatus,
      claim_status_text: claimStatusLookup(valDataVals.claimStatus),
      mainchain_tx: valDataVals.mainchainTx,
      ethereum_tx: valDataVals.ethereumTx,
      created: valDataVals.createdAt,
      amount: valDataVals.amount,
      nonce: valDataVals.nonce,
      eth_address: valDataVals.ethAddress,
    }
    results.push(v)
  }

  return results
}

router.get("/", async (req, res) => {
  const result = { ...DEFAULT_JSON_RESPONSE }

  try {
    result.success = true
    result.status = STATUS_CODES.OK
    delete result.error
    result.result = processClaimResult(await getAllClaimTickets())
  } catch (error) {
    result.success = false
    result.status = STATUS_CODES.ERR.DB_QUERY_ERROR
    result.error = `${errorCodeLookup(STATUS_CODES.ERR.DB_QUERY_ERROR)}: ${error.message}`
  }
  res.json(result)
})

router.get("/address/:address", async (req, res) => {
  const { address } = req.params
  const result = { ...DEFAULT_JSON_RESPONSE }

  if (!address) {
    result.error = "missing address"
  } else {
    try {
      result.success = true
      result.status = STATUS_CODES.OK
      delete result.error
      result.result = processClaimResult(await getAllClaimTicketsByAddress(address))
    } catch (error) {
      result.success = false
      result.status = STATUS_CODES.ERR.DB_QUERY_ERROR
      result.error = `${errorCodeLookup(STATUS_CODES.ERR.DB_QUERY_ERROR)}: ${error.message}`
    }
  }

  res.json(result)
})

router.get("/status/:claim_status", async (req, res) => {
  const { claim_status } = req.params

  const result = { ...DEFAULT_JSON_RESPONSE }

  if (!isValidClaimStatus(claim_status)) {
    result.error = "missing valid claim status"
  } else {
    try {
      result.success = true
      result.status = STATUS_CODES.OK
      delete result.error
      result.result = await processClaimResult(await getClaimTicketsByStatus(claim_status))
    } catch (error) {
      result.success = false
      result.status = STATUS_CODES.ERR.DB_QUERY_ERROR
      result.error = `${errorCodeLookup(STATUS_CODES.ERR.DB_QUERY_ERROR)}: ${error.message}`
    }
  }

  res.json(result)
})

router.get("/address/:address/status/:claim_status", async (req, res) => {
  const { address, claim_status } = req.params

  const result = { ...DEFAULT_JSON_RESPONSE }

  if (!isValidClaimStatus(claim_status) || !address) {
    result.error = "missing address or valid claim status"
  } else {
    try {
      result.success = true
      result.status = STATUS_CODES.OK
      delete result.error
      result.result = processClaimResult(await getClaimTicketsByAddressAndStatus(address, claim_status))
    } catch (error) {
      result.success = false
      result.status = STATUS_CODES.ERR.DB_QUERY_ERROR
      result.error = `${errorCodeLookup(STATUS_CODES.ERR.DB_QUERY_ERROR)}: ${error.message}`
    }
  }

  res.json(result)
})

router.get("/address/:address/mctx/:mctx", async (req, res) => {
  const { address, mctx } = req.params

  const result = { ...DEFAULT_JSON_RESPONSE }

  if (!mctx || !address) {
    result.error = "missing address or mainchain tx hash"
  } else {
    try {
      result.success = true
      result.status = STATUS_CODES.OK
      delete result.error
      result.result = processClaimResult(await getClaimTicketsByAddressAndMcTx(address, mctx))
    } catch (error) {
      result.success = false
      result.status = STATUS_CODES.ERR.DB_QUERY_ERROR
      result.error = `${errorCodeLookup(STATUS_CODES.ERR.DB_QUERY_ERROR)}: ${error.message}`
    }
  }

  res.json(result)
})

const checkMemoPayload = (ethAddress, selfDelegatorAddress) => {
  if (!ethAddress || !selfDelegatorAddress) {
    throw new Error("missing ethereum address or self delegator address")
  }
  if (!Web3.utils.isAddress(ethAddress)) {
    throw new Error(`invalid ethereum address: ${ethAddress}`)
  }
  if (!checkBech32Address(selfDelegatorAddress, "und")) {
    throw new Error(`invalid self delegator address: ${selfDelegatorAddress}`)
  }
}

const processMemo = async (payload) => {
  const result = { ...DEFAULT_JSON_RESPONSE }

  let selfDelegatorAddress
  let ethAddress
  try {
    const decodedPayload = jwt.verify(payload, JWT_SHARED_SECRET)
    ethAddress = decodedPayload.eth_address
    selfDelegatorAddress = decodedPayload.self_delegate_address
    checkMemoPayload(ethAddress, selfDelegatorAddress)
  } catch (err) {
    result.success = false
    result.status = STATUS_CODES.ERR.JWT
    result.error = err.message
    return result
  }

  const dbVal = await getBySelfDelegatorAddress(selfDelegatorAddress)
  if (!dbVal) {
    result.success = false
    result.status = STATUS_CODES.ERR.DB_NOT_FOUND
    result.error = `${errorCodeLookup(STATUS_CODES.ERR.DB_NOT_FOUND)}: ${selfDelegatorAddress} not found`
    return result
  }

  const memoKey = await getMemoKey(dbVal.id)

  const res = {
    memo: jwtiseMemo(ethAddress, selfDelegatorAddress, memoKey.memoKey),
  }

  result.success = true
  result.result = res
  result.status = STATUS_CODES.OK
  delete result.error

  return result
}

router.post("/memo", async (req, res) => {
  try {
    const { payload } = req.body
    if (!payload) {
      res.json({ success: false, error: "missing payload", result: {} })
    } else {
      res.json(await processMemo(payload))
    }
  } catch (error) {
    res.json({ success: false, error: error.toString(), result: {} })
  }
})

const ticketSuccessBody = (result, ticket, amount, nonce, ethAddr, claimStatus, ethTx) => {
  const retRes = { ...result }
  const resultBody = {}
  if (claimStatus === TICKET_CLAIM_STATUS.CLAIMED) {
    resultBody.claim_ticket = ""
  } else {
    resultBody.claim_ticket = jwtiseTicket(ticket, amount, nonce, ethAddr)
  }

  resultBody.claim_status = claimStatus
  resultBody.eth_tx = ethTx

  retRes.success = true
  retRes.status = STATUS_CODES.OK
  retRes.result = resultBody
  delete retRes.error
  return retRes
}

const issueTicket = async (txHash, ethSigNonce, ethSig, parsedNonce, claimTicketId) => {
  const result = { ...DEFAULT_JSON_RESPONSE }

  let ethAddr = null
  let validatorId = null

  let totalClaim = 0
  let ticketInsId
  let ticketNonce

  if (!claimTicketId) {
    // new ticket - a claim has not yet been requested with this Mainchain Tx hash, so process it.
    const tx = await getTx(txHash)

    // validate the tx and its memo - check it's actually from the validator etc.
    const txRes = await validateClaimTx(tx, ethSigNonce, ethSig)

    if (txRes.status !== STATUS_CODES.OK) {
      result.success = false
      result.status = txRes.status
      result.error = `${errorCodeLookup(txRes.status)}: ${txRes.errorMsg}`
      return result
    }

    // get from validated Tx result
    ethAddr = txRes.ethAddr
    validatorId = txRes.validatorId

    const emissionIds = []

    // get the last known nonce used for this eth address, according to the oracle
    // and cross reference with the nonce sent in the request (which should be obtained
    // from the smart contract)
    const lastNonce = await getLastNonce(ethAddr)
    if (lastNonce) {
      if (parsedNonce !== lastNonce + 1) {
        result.success = false
        result.status = STATUS_CODES.ERR.NONCE
        result.error = `${errorCodeLookup(STATUS_CODES.ERR.NONCE)}: expected nonce ${
          lastNonce + 1
        }, got ${parsedNonce} - nonce must be exactly 1 greater than last nonce ${lastNonce}`
        return result
      }
    }

    // double check have emissions to claim
    const unclaimedEmissions = await getUnclaimedEmissionsForValidatorId(validatorId)
    if (unclaimedEmissions.length === 0) {
      result.success = false
      result.status = STATUS_CODES.ERR.EMISSION
      result.error = `${errorCodeLookup(STATUS_CODES.ERR.EMISSION)}: currently no emissions to claim`
      return result
    }

    for (let i = 0; i < unclaimedEmissions.length; i += 1) {
      emissionIds.push(unclaimedEmissions[i].dataValues.id)
      totalClaim += 1
    }

    // insert claim ticket with "Staged" status.
    try {
      ticketInsId = await insertClaimTicket(
        totalClaim,
        ethAddr,
        parsedNonce,
        txHash,
        validatorId,
        emissionIds,
      )
    } catch (insErr) {
      result.success = false
      result.status = STATUS_CODES.ERR.DB_INS
      result.error = `${errorCodeLookup(STATUS_CODES.ERR.DB_INS)}: ${insErr.toString()}`
      return result
    }
    if (ticketInsId === 0) {
      result.success = false
      result.status = STATUS_CODES.ERR.DB_INS
      result.error = `${errorCodeLookup(STATUS_CODES.ERR.DB_INS)}: error creating claim ticket`
      return result
    }

    ticketNonce = parsedNonce
  } else {
    // ticket staged but not yet issued
    const stagedClaimTicket = await getClaimTicketById(claimTicketId)
    if (stagedClaimTicket) {
      ethAddr = stagedClaimTicket.ethAddress
      validatorId = stagedClaimTicket.validatorId
      totalClaim = stagedClaimTicket.amount
      ticketNonce = stagedClaimTicket.nonce
    } else {
      // something really went wrong
      result.success = false
      result.status = STATUS_CODES.ERR.UNSPECIFIED
      result.error = `${errorCodeLookup(STATUS_CODES.ERR.UNSPECIFIED)}: unknown error...`
      return result
    }

    // mirror this for later
    ticketInsId = claimTicketId
  }

  if (
    Web3.utils.isAddress(ethAddr) &&
    validatorId > 0 &&
    totalClaim > 0 &&
    ticketNonce > 0 &&
    ticketInsId > 0
  ) {
    // generate the actual ticket
    const ticketData = await generateClaimTicket(ethAddr, totalClaim, parsedNonce)
    const claimTicket = ticketData.ticket.signature

    // check a claim ticket hasn't already been generated for this combination
    const ticketRes = await getClaimTicketByTicket(claimTicket)

    if (ticketRes) {
      result.success = false
      result.status = STATUS_CODES.ERR.CLAIM_TICKET
      result.error = `${errorCodeLookup(
        STATUS_CODES.ERR.CLAIM_TICKET,
      )}: ticket already generated for address, amount and nonce`
      return result
    }
    // update the claim ticket's status to "issued" and set actual ticket data
    try {
      await updateClaimTicketWithTicket(ticketInsId, JSON.stringify(ticketData.ticket))
      return ticketSuccessBody(
        result,
        claimTicket,
        totalClaim,
        parsedNonce,
        ethAddr,
        TICKET_CLAIM_STATUS.ISSUED,
        "",
      )
    } catch (err) {
      result.success = false
      result.status = STATUS_CODES.ERR.DB_UPD
      result.error = `${errorCodeLookup(STATUS_CODES.ERR.DB_UPD)}: ${err.toString()}`
      return result
    }
  } else {
    result.success = false
    result.status = STATUS_CODES.ERR.UNSPECIFIED
    result.error = `${errorCodeLookup(STATUS_CODES.ERR.UNSPECIFIED)}: unknown error...`
    return result
  }
}

const processTicket = async (payload) => {
  const result = { ...DEFAULT_JSON_RESPONSE }

  let txHash
  let nonce
  let ethSig
  let ethSigNonce
  try {
    const decodedPayload = jwt.verify(payload, JWT_SHARED_SECRET)
    txHash = decodedPayload.tx_hash
    nonce = decodedPayload.nonce
    ethSigNonce = decodedPayload.sig_nonce
    ethSig = decodedPayload.sig
  } catch (err) {
    result.success = false
    result.status = STATUS_CODES.ERR.JWT
    result.error = err.message
    return result
  }

  if (isNaN(nonce) || nonce === 0) {
    result.success = false
    result.status = STATUS_CODES.ERR.CLAIM_TICKET
    result.error = `${errorCodeLookup(STATUS_CODES.ERR.CLAIM_TICKET)}: nonce ${nonce} is not a valid number`
    return result
  }

  const parsedNonce = parseInt(nonce, 10)

  // check if a claim has been initialised with this Mainchain Tx
  const ticketExists = await getClaimTicketByMainchainTx(txHash)

  // if it exists, check the recorded ticket's eth address matches the requestor's eth address
  // used to sign this request. Only the owner of the ticket should be able to request this
  if (ticketExists) {
    const domain = [...xFundSigDomain]
    const txData = [...xFundSigTxData]
    const domainData = { ...xFundSigDomainData }
    const message = {
      tx_hash: txHash,
      sig_nonce: ethSigNonce,
    }
    const msgParams = JSON.stringify({
      types: {
        EIP712Domain: domain,
        TxData: txData,
      },
      domain: domainData,
      primaryType: "TxData",
      message,
    })

    const recovered = sigUtil.recoverTypedSignature({ data: JSON.parse(msgParams), sig: ethSig })

    if (Web3.utils.toChecksumAddress(ticketExists.ethAddress) !== Web3.utils.toChecksumAddress(recovered)) {
      result.success = false
      result.status = STATUS_CODES.ERR.ETH_ADDR
      result.error = `Eth Sig Error: eth address "${ticketExists.ethAddress}" does not match recovered signature address "${recovered}"`
      return result
    }

    // return the existing ticket data and current claim status
    const ticketJson = JSON.parse(ticketExists.ticket)
    switch (ticketExists.claimStatus) {
      case TICKET_CLAIM_STATUS.ISSUED:
      case TICKET_CLAIM_STATUS.CLAIMED:
        return ticketSuccessBody(
          result,
          ticketJson.signature,
          ticketExists.amount,
          ticketExists.nonce,
          ticketExists.ethAddress,
          ticketExists.claimStatus,
          ticketExists.ethereumTx,
        )
      case TICKET_CLAIM_STATUS.INITIALISED:
        return issueTicket(txHash, ethSigNonce, ethSig, parsedNonce, ticketExists.id)
      default:
        result.success = false
        result.status = STATUS_CODES.ERR.UNSPECIFIED
        result.error = `${errorCodeLookup(STATUS_CODES.ERR.UNSPECIFIED)}: claim status ${
          ticketExists.claimStatus
        } unknown...`
        return result
    }
  }

  return issueTicket(txHash, ethSigNonce, ethSig, parsedNonce, null)
}

router.post("/ticket", async (req, res) => {
  try {
    const { payload } = req.body
    if (!payload) {
      res.json({ success: false, error: "missing payload", result: {} })
    } else {
      res.json(await processTicket(payload))
    }
  } catch (error) {
    res.json({ success: false, error: error.toString(), result: {} })
  }
})

const processEthTx = async (payload) => {
  const result = { ...DEFAULT_JSON_RESPONSE }

  let mainchainTx
  let ethAddress
  let ethTx
  try {
    const decodedPayload = jwt.verify(payload, JWT_SHARED_SECRET)
    mainchainTx = decodedPayload.mainchain_tx
    ethAddress = decodedPayload.eth_address
    ethTx = decodedPayload.eth_tx

    const claimTicket = await getClaimTicketByMainchainTxAndEthAddr(mainchainTx, ethAddress)

    if (!claimTicket) {
      result.success = false
      result.status = STATUS_CODES.ERR.DB_NOT_FOUND
      result.error = `Mainchain Tx ${mainchainTx} and Eth address ${ethAddress} not found`
      return result
    }

    await updateClaimTicketWithEthTx(claimTicket.id, ethTx)

    await updateMemoKey(claimTicket.validatorId)

    result.status = STATUS_CODES.OK
    result.success = true
    return result
  } catch (err) {
    result.success = false
    result.status = STATUS_CODES.ERR.JWT
    result.error = err.message
    return result
  }
}

router.post("/ethtx", async (req, res) => {
  try {
    const { payload } = req.body
    if (!payload) {
      res.json({ success: false, error: "missing payload", result: {} })
    } else {
      res.json(await processEthTx(payload))
    }
  } catch (error) {
    res.json({ success: false, error: error.toString(), result: {} })
  }
})

module.exports = router
