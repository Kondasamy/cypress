import debugModule from 'debug'
import http from 'http'
import https from 'https'
import _ from 'lodash'
import net from 'net'
import { getProxyForUrl } from 'proxy-from-env'
import url from 'url'
import { createRetryingSocket, getAddress } from './connect'

const debug = debugModule('cypress:network:agent')
const CRLF = '\r\n'
const statusCodeRe = /^HTTP\/1.[01] (\d*)/

interface RequestOptionsWithProxy extends http.RequestOptions {
  proxy: string
  shouldRetry?: boolean
}

type FamilyCache = {
  [host: string] : 4 | 6
}

export function buildConnectReqHead(hostname: string, port: string, proxy: url.Url) {
  const connectReq = [`CONNECT ${hostname}:${port} HTTP/1.1`]

  connectReq.push(`Host: ${hostname}:${port}`)

  if (proxy.auth) {
    connectReq.push(`Proxy-Authorization: basic ${Buffer.from(proxy.auth).toString('base64')}`)
  }

  return connectReq.join(CRLF) + _.repeat(CRLF, 2)
}

interface CreateProxySockOpts {
  proxy: url.Url
  shouldRetry?: boolean
}

type CreateProxySockCb = (
  (err: undefined, result: net.Socket, triggerRetry: (err: Error) => void) => void
) & (
  (err: Error) => void
)

export const createProxySock = (opts: CreateProxySockOpts, cb: CreateProxySockCb) => {
  if (opts.proxy.protocol !== 'https:' && opts.proxy.protocol !== 'http:') {
    return cb(new Error(`Unsupported proxy protocol: ${opts.proxy.protocol}`))
  }

  const isHttps = opts.proxy.protocol === 'https:'
  const port = opts.proxy.port || (isHttps ? 443 : 80)

  let connectOpts: any = {
    port: Number(port),
    host: opts.proxy.hostname,
    useTls: isHttps
  }

  if (!opts.shouldRetry) {
    connectOpts.getDelayMsForRetry = () => undefined
  }

  createRetryingSocket(connectOpts, (err, sock, triggerRetry) => {
    if (err) {
      return cb(err)
    }

    cb(undefined, <net.Socket>sock, <CreateProxySockCb>triggerRetry)
  })
}

export const isRequestHttps = (options: http.RequestOptions) => {
  // WSS connections will not have an href, but you can tell protocol from the defaultAgent
  return _.get(options, '_defaultAgent.protocol') === 'https:' || (options.href || '').slice(0, 6) === 'https'
}

export const isResponseStatusCode200 = (head: string) => {
  // read status code from proxy's response
  const matches = head.match(statusCodeRe)
  return _.get(matches, 1) === '200'
}

export const regenerateRequestHead = (req: http.ClientRequest) => {
  delete req._header
  req._implicitHeader()
  if (req.output && req.output.length > 0) {
    // the _header has already been queued to be written to the socket
    const first = req.output[0]
    const endOfHeaders = first.indexOf(_.repeat(CRLF, 2)) + 4
    req.output[0] = req._header + first.substring(endOfHeaders)
  }
}

const getFirstWorkingFamily = (
  { port, host }: http.RequestOptions,
  familyCache: FamilyCache,
  cb: Function
) => {
  // this is a workaround for localhost (and potentially others) having invalid
  // A records but valid AAAA records. here, we just cache the family of the first
  // returned A/AAAA record for a host that we can establish a connection to.
  // https://github.com/cypress-io/cypress/issues/112

  const isIP = net.isIP(host)
  if (isIP) {
    // isIP conveniently returns the family of the address
    return cb(isIP)
  }

  if (process.env.HTTP_PROXY) {
    // can't make direct connections through the proxy, this won't work
    return cb()
  }

  if (familyCache[host]) {
    return cb(familyCache[host])
  }

  return getAddress(port, host)
  .then((firstWorkingAddress: net.Address) => {
    familyCache[host] = firstWorkingAddress.family
    return cb(firstWorkingAddress.family)
  })
  .catch(() => {
    return cb()
  })
}

export class CombinedAgent {
  httpAgent: HttpAgent
  httpsAgent: HttpsAgent
  familyCache: FamilyCache = {}

  constructor(httpOpts: http.AgentOptions = {}, httpsOpts: https.AgentOptions = {}) {
    this.httpAgent = new HttpAgent(httpOpts)
    this.httpsAgent = new HttpsAgent(httpsOpts)
  }

  // called by Node.js whenever a new request is made internally
  addRequest(req: http.ClientRequest, options: http.RequestOptions) {
    const isHttps = isRequestHttps(options)

    if (!options.href) {
      // options.path can contain query parameters, which url.format will not-so-kindly urlencode for us...
      // so just append it to the resultant URL string
      options.href = url.format({
        protocol: isHttps ? 'https:' : 'http:',
        slashes: true,
        hostname: options.host,
        port: options.port,
      }) + options.path

      if (!options.uri) {
        options.uri = url.parse(options.href)
      }
    }

    debug(`addRequest called for ${options.href}`)

    return getFirstWorkingFamily(options, this.familyCache, (family: net.family) => {
      options.family = family

      if (isHttps) {
        return this.httpsAgent.addRequest(req, options)
      }

      this.httpAgent.addRequest(req, options)
    })
  }
}

class HttpAgent extends http.Agent {
  httpsAgent: https.Agent

  constructor (opts: http.AgentOptions = {}) {
    opts.keepAlive = true
    super(opts)
    // we will need this if they wish to make http requests over an https proxy
    this.httpsAgent = new https.Agent({ keepAlive: true })
  }

  createSocket (req: http.ClientRequest, options: http.RequestOptions, cb: http.SocketCallback) {
    if (process.env.HTTP_PROXY) {
      const proxy = getProxyForUrl(options.href)

      if (proxy) {
        options.proxy = proxy

        return this._createProxiedSocket(req, <RequestOptionsWithProxy>options, cb)
      }
    }

    super.createSocket(req, options, cb)
  }

  _createProxiedSocket (req: http.ClientRequest, options: RequestOptionsWithProxy, cb: http.SocketCallback) {
    debug(`Creating proxied socket for ${options.href} through ${options.proxy}`)

    const proxy = url.parse(options.proxy)

    // set req.path to the full path so the proxy can resolve it
    // @ts-ignore: Cannot assign to 'path' because it is a constant or a read-only property.
    req.path = options.href

    delete req._header // so we can set headers again

    req.setHeader('host', `${options.host}:${options.port}`)
    if (proxy.auth) {
      req.setHeader('proxy-authorization', `basic ${Buffer.from(proxy.auth).toString('base64')}`)
    }

    // node has queued an HTTP message to be sent already, so we need to regenerate the
    // queued message with the new path and headers
    // https://github.com/TooTallNate/node-http-proxy-agent/blob/master/index.js#L93
    regenerateRequestHead(req)

    options.port = Number(proxy.port || 80)
    options.host = proxy.hostname || 'localhost'
    delete options.path // so the underlying net.connect doesn't default to IPC

    if (proxy.protocol === 'https:') {
      // gonna have to use the https module to reach the proxy, even though this is an http req
      req.agent = this.httpsAgent

      return this.httpsAgent.addRequest(req, options)
    }

    super.createSocket(req, options, cb)
  }
}

class HttpsAgent extends https.Agent {
  constructor (opts: https.AgentOptions = {}) {
    opts.keepAlive = true
    super(opts)
  }

  createConnection (options: http.RequestOptions, cb: http.SocketCallback) {
    if (process.env.HTTPS_PROXY) {
      const proxy = getProxyForUrl(options.href)

      if (proxy) {
        options.proxy = <string>proxy

        return this.createUpstreamProxyConnection(<RequestOptionsWithProxy>options, cb)
      }
    }

    // @ts-ignore
    cb(null, super.createConnection(options))
  }

  createUpstreamProxyConnection (options: RequestOptionsWithProxy, cb: http.SocketCallback) {
    // heavily inspired by
    // https://github.com/mknj/node-keepalive-proxy-agent/blob/master/index.js
    debug(`Creating proxied socket for ${options.href} through ${options.proxy}`)

    const proxy = url.parse(options.proxy)
    const port = options.uri.port || '443'
    const hostname = options.uri.hostname || 'localhost'

    createProxySock({ proxy, shouldRetry: options.shouldRetry }, (originalErr?, proxySocket?, triggerRetry?) => {
      if (originalErr) {
        const err: any = new Error(`A connection to the upstream proxy could not be established: ${originalErr.message}`)
        err[0] = originalErr
        err.upstreamProxyConnect = true
        return cb(err, undefined)
      }

      const onClose = () => {
        triggerRetry(new Error('The upstream proxy closed the socket after connecting but before sending a response.'))
      }

      const onError = (err: Error) => {
        triggerRetry(err)
        proxySocket.destroy()
      }

      let buffer = ''

      const onData = (data: Buffer) => {
        debug(`Proxy socket for ${options.href} established`)

        buffer += data.toString()

        if (!_.includes(buffer, _.repeat(CRLF, 2))) {
          // haven't received end of headers yet, keep buffering
          proxySocket.once('data', onData)
          return
        }

        // we've now gotten enough of a response not to retry
        // connecting to the proxy
        proxySocket.removeListener('error', onError)
        proxySocket.removeListener('close', onClose)

        if (!isResponseStatusCode200(buffer)) {
          return cb(new Error(`Error establishing proxy connection. Response from server was: ${buffer}`), undefined)
        }

        if (options._agentKey) {
          // https.Agent will upgrade and reuse this socket now
          options.socket = proxySocket
          options.servername = hostname
          return cb(undefined, super.createConnection(options, undefined))
        }

        cb(undefined, proxySocket)
      }

      proxySocket.once('close', onClose)
      proxySocket.once('error', onError)
      proxySocket.once('data', onData)

      const connectReq = buildConnectReqHead(hostname, port, proxy)

      proxySocket.write(connectReq)
    })
  }
}

const agent = new CombinedAgent()

export default agent
