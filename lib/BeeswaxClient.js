'use strict'

var urlUtils = require('url'),
  util = require('util'),
  Promise = require('bluebird'),
  request = require('request'),
  rp = require('request-promise'),
  rpErrors = require('request-promise/errors')

// Node doesn't have Beeswax's root CAs' SSL certs; this module injects common root CAs' certs
// into https.globalAgent.options + fixes the issue
require('ssl-root-cas').inject()

// Return true if value is a Plain Old Javascript Object
function isPOJO(value) {
  return !!(value && value.constructor === Object)
}

// Upon instantiation, will setup objects with bound CRUD methods for each entry here
var entities = {
  advertisers: {
    endpoint: '/rest/v2/advertisers',
    idField: 'advertiser_id',
  },
  campaigns: {
    endpoint: '/rest/v2/campaigns',
    idField: 'campaign_id',
  },
  creatives: {
    endpoint: '/rest/creative',
    idField: 'creative_id',
  }, // Deprecated
  lineItems: {
    endpoint: '/rest/v2/line-items',
    idField: 'line_item_id',
  },
  lineItemFlights: {
    endpoint: '/rest/line_item_flight',
    idField: 'line_item_flight_id',
  }, // Deprecated
  targetingTemplates: {
    endpoint: '/rest/v2/targeting-expressions',
    idField: 'targeting_template_id',
  },
  segmentUploads: {
    // Deprecated
    endpoint: '/rest/segment_upload',
    idField: 'segment_upload_id',
  },
  segmentCategorySharings: {
    // Deprecated
    endpoint: '/rest/segment_category_sharing',
    idField: 'segment_category_sharing_id',
  },
  segmentSharings: {
    // Deprecated
    endpoint: '/rest/segment_sharing',
    idField: 'segment_sharing_id',
  },
  segmentCategoryAssociations: {
    // Deprecated
    endpoint: '/rest/segment_category_association',
    idField: 'segment_category_association_id',
  },
  segments: {
    // Deprecated
    endpoint: '/rest/segment',
    idField: 'segment_id',
  },
  segmentCategories: {
    // Deprecated
    endpoint: '/rest/segment_category',
    idField: 'segment_category_id',
  },
}

function BeeswaxClient(opts) {
  var self = this

  opts = opts || {}
  if (!opts.creds || !opts.creds.email || !opts.creds.password) {
    throw new Error('Must provide creds object with email + password')
  }

  self.apiRoot = opts.apiRoot || 'https://stingersbx.api.beeswax.com'
  self._creds = opts.creds
  self._cookieJar = rp.jar()

  Object.keys(entities).forEach(function (type) {
    var cfg = entities[type]
    self[type] = {}
    self[type].find = self._find.bind(self, cfg.endpoint)
    self[type].query = self._query.bind(self, cfg.endpoint)
    self[type].queryAll = self._queryAll.bind(self, cfg.endpoint, cfg.idField)
    self[type].create = self._create.bind(self, cfg.endpoint, cfg.idField)
    self[type].edit = self._edit.bind(self, cfg.endpoint)
    self[type].putEdit = self._putEdit.bind(self, cfg.endpoint)
    self[type].delete = self._delete.bind(self, cfg.endpoint)
  })
}

// Send a request to authenticate to Beeswax
BeeswaxClient.prototype.authenticate = function () {
  var self = this

  // Ensure we don't make multiple simulataneous auth requests
  if (self._authPromise) {
    return self._authPromise
  }

  self._authPromise = rp
    .post({
      url: urlUtils.resolve(self.apiRoot, '/rest/v2/authenticate'),
      body: {
        email: self._creds.email,
        password: self._creds.password,
        keep_logged_in: true, // tells Beeswax to use longer lasting sessions
      },
      json: true,
      jar: self._cookieJar,
    })
    .then(function (body) {
      if (body.success === false) {
        return Promise.reject(new Error(util.inspect(body)))
      }
    })
    .catch(function (error) {
      delete error.response // Trim response obj off error for cleanliness
      return Promise.reject(error)
    })
    .finally(function () {
      delete self._authPromise
    })

  return self._authPromise
}

// Send a request to Beeswax, handling '401 - Unauthenticated' errors
BeeswaxClient.prototype.request = function (method, opts) {
  var self = this

  opts.json = true
  opts.jar = self._cookieJar

  return (function sendRequest() {
    return rp[method](opts).catch(rpErrors.StatusCodeError, function (error) {
      if (error.statusCode !== 401) {
        return Promise.reject(error)
      }

      return self.authenticate().then(sendRequest)
    })
  })()
    .then(function (body) {
      if (body && body.success === false) {
        return Promise.reject(new Error(util.inspect(body)))
      }
      return body
    })
    .catch(function (error) {
      delete error.response // Trim response obj off error for cleanliness
      return Promise.reject(error)
    })
}

// Send a GET request to find a single entity by id
BeeswaxClient.prototype._find = function (endpoint, id) {
  var opts = {
    url: urlUtils.resolve(this.apiRoot, `${endpoint}/${id}`),
    body: {},
  }
  return this.request('get', opts).then(function (body) {
    return { success: true, payload: body }
  })
}

// Send a GET request to fetch entities by JSON query
BeeswaxClient.prototype._query = function (endpoint, body) {
  var opts = {
    url: urlUtils.resolve(this.apiRoot, endpoint),
    body: body || {},
  }
  return this.request('get', opts).then(function (body) {
    return { success: true, payload: body }
  })
}

// Recursively GET entities in batches until all have been fetched.
BeeswaxClient.prototype._queryAll = function (endpoint, idField, body) {
  var self = this,
    results = [],
    batchSize = 50
  body = body || {}

  function fetchBatch(offset) {
    var opts = {
      url: urlUtils.resolve(self.apiRoot, endpoint),
      body: {},
    }
    for (var key in body) {
      opts.body[key] = body[key]
    }
    opts.body.rows = batchSize
    opts.body.offset = offset
    opts.body.sort_by = idField

    return self.request('get', opts).then(function (respBody) {
      results = results.concat(respBody.payload)

      if (respBody.payload.length < batchSize) {
        return { success: true, payload: results }
      } else {
        return fetchBatch(offset + batchSize)
      }
    })
  }

  return fetchBatch(0)
}

// Send a POST request to create a new entity. GETs + resolves with the created entity.
BeeswaxClient.prototype._create = function (endpoint, idField, body) {
  var self = this
  // Beeswax sends a weird 401 error if a body is empty, so handle this here
  if (!isPOJO(body) || Object.keys(body || {}).length === 0) {
    return Promise.resolve({
      success: false,
      code: 400,
      message: 'Body must be non-empty object',
    })
  }

  var opts = {
    url: urlUtils.resolve(self.apiRoot, endpoint),
    body: body,
  }
  return self.request('post', opts).then(function (body) {
    return self._find(endpoint, body.id)
  })
}

// Send a patch request to edit an existing entity by id. GETs + resolves with the updated entity.
BeeswaxClient.prototype._edit = function (endpoint, id, body, failOnNotFound) {
  var self = this
  if (!isPOJO(body) || Object.keys(body || {}).length === 0) {
    return Promise.resolve({
      success: false,
      code: 400,
      message: 'Body must be non-empty object',
    })
  }

  var opts = {
    url: urlUtils.resolve(this.apiRoot, `${endpoint}/${id}`),
    body: body,
  }

  return this.request('patch', opts)
    .then(function (/*body*/) {
      return self._find(endpoint, id)
    })
    .catch(function (resp) {
      var notFound = false
      var specificErrors = []
      var errorMessages = []

      // Check if the error is related to specific non_field_errors
      if (
        resp.statusCode === 400 &&
        resp.error &&
        resp.error.non_field_errors
      ) {
        specificErrors = resp.error.non_field_errors
      }

      // Catch and return "object not found" errors as unsuccessful responses
      try {
        notFound = resp.error.payload[0].message.some(function (str) {
          return /Could not load object.*to update/.test(str)
        })
      } catch (e) {}

      if (specificErrors.length > 0) {
        errorMessages = specificErrors.join(', ')
        return Promise.resolve({
          success: false,
          code: 400,
          message: `Error(s): ${errorMessages}`,
        })
      }

      if (!!notFound && !failOnNotFound) {
        return Promise.resolve({
          success: false,
          code: 400,
          message: 'Not found',
        })
      }

      return Promise.reject(resp)
    })
}

// Send a put request to edit an existing entity by id. GETs + resolves with the updated entity.
BeeswaxClient.prototype._putEdit = function (
  endpoint,
  id,
  body,
  failOnNotFound
) {
  var self = this
  if (!isPOJO(body) || Object.keys(body || {}).length === 0) {
    return Promise.resolve({
      success: false,
      code: 400,
      message: 'Body must be non-empty object',
    })
  }

  var opts = {
    url: urlUtils.resolve(this.apiRoot, `${endpoint}/${id}`),
    body: body,
  }

  return this.request('put', opts)
    .then(function (/*body*/) {
      return self._find(endpoint, id)
    })
    .catch(function (resp) {
      var notFound = false
      var specificErrors = []
      var errorMessages = []

      // Check if the error is related to specific non_field_errors
      if (
        resp.statusCode === 400 &&
        resp.error &&
        resp.error.non_field_errors
      ) {
        specificErrors = resp.error.non_field_errors
      }

      // Catch and return "object not found" errors as unsuccessful responses
      try {
        notFound = resp.error.payload[0].message.some(function (str) {
          return /Could not load object.*to update/.test(str)
        })
      } catch (e) {}

      if (specificErrors.length > 0) {
        errorMessages = specificErrors.join(', ')
        return Promise.resolve({
          success: false,
          code: 400,
          message: `Error(s): ${errorMessages}`,
        })
      }

      if (!!notFound && !failOnNotFound) {
        return Promise.resolve({
          success: false,
          code: 400,
          message: 'Not found',
        })
      }

      return Promise.reject(resp)
    })
}

// Send a DELETE request to delete an entity by id
BeeswaxClient.prototype._delete = function (endpoint, id, failOnNotFound) {
  var opts = {
    url: urlUtils.resolve(this.apiRoot, `${endpoint}/${id}`),
    body: {},
  }

  return this.request('del', opts)
    .then(function (body) {
      return { success: true, payload: body }
    })
    .catch(function (resp) {
      var notFound = false
      var associatedError = false
      var otherErrors = []

      // Check if the error is related to associated campaigns
      if (
        resp.statusCode === 400 &&
        resp.error &&
        resp.error.non_field_errors
      ) {
        associatedError = resp.error.non_field_errors.some(function (str) {
          return /Cannot delete this advertiser. It has one or more associated campaigns/.test(
            str
          )
        })
      }

      // Catch and return "object not found" errors as unsuccessful responses
      try {
        notFound = resp.error.payload[0].message.some(function (str) {
          return /Could not load object.*to delete/.test(str)
        })
      } catch (e) {}

      // Handle additional specific errors here
      if (
        resp.statusCode === 400 &&
        resp.error &&
        resp.error.non_field_errors
      ) {
        otherErrors = resp.error.non_field_errors.filter(function (str) {
          return !/Cannot delete this advertiser. It has one or more associated campaigns/.test(
            str
          )
        })
      }

      if (associatedError) {
        return Promise.resolve({
          success: false,
          code: 400,
          message:
            'Cannot delete this advertiser. It has one or more associated campaigns.',
        })
      }

      if (otherErrors.length > 0) {
        return Promise.resolve({
          success: false,
          code: 400,
          message: `Error(s): ${otherErrors.join(', ')}`,
        })
      }

      if (!!notFound && !failOnNotFound) {
        return Promise.resolve({
          success: false,
          code: 400,
          message: 'Not found',
        })
      }

      console.log('resp', resp)

      return Promise.reject(resp)
    })
}

BeeswaxClient.prototype.uploadCreativeAsset = function (params) {
  var self = this

  function init(params) {
    var assetDef = {},
      props = [
        'advertiser_id',
        'creative_asset_name',
        'size_in_bytes',
        'notes',
        'active',
      ]

    props.forEach(function (prop) {
      if (params[prop]) {
        assetDef[prop] = params[prop]
      }
    })

    if (!params.sourceUrl) {
      return Promise.reject(
        new Error('uploadCreativeAsset params requires a sourceUrl property.')
      )
    }

    if (!assetDef.creative_asset_name) {
      assetDef.creative_asset_name = urlUtils
        .parse(params.sourceUrl)
        .pathname.split('/')
        .pop()
    }

    return Promise.resolve({ req: params, assetDef: assetDef })
  }

  function getSize(data) {
    return new Promise(function (resolve, reject) {
      var opts = {
        url: data.req.sourceUrl,
      }

      request.head(opts, function (error, response, body) {
        if (error) {
          return reject(error)
        } else if (response.statusCode !== 200) {
          return reject(body)
        }

        if (response.headers['content-length']) {
          data.assetDef.size_in_bytes = parseInt(
            response.headers['content-length'],
            10
          )
          return resolve(data)
        }

        return reject(
          new Error(
            'Unable to detect content-length of sourceUrl: ' +
              data.req.sourceUrl
          )
        )
      })
    })
  }

  function createAsset(data) {
    var opts = {
      url: urlUtils.resolve(self.apiRoot, '/rest/creative_asset'),
      body: data.assetDef,
    }

    return self.request('post', opts).then(function (body) {
      data.createResponse = body
      return data
    })
  }

  function postFile(data) {
    return new Promise(function (resolve, reject) {
      var opts = {
        url: urlUtils.resolve(
          self.apiRoot,
          '/rest/creative_asset/upload/' + data.createResponse.payload.id
        ),
        jar: self._cookieJar,
      }

      var r = request.post(opts, function (error, response, body) {
        if (error) {
          return reject(error)
        } else if (response.statusCode !== 200) {
          return reject(body)
        }

        data.postFileResponse = JSON.parse(body)
        return resolve(data)
      })

      var form = r.form()
      form.append('creative_content', request(data.req.sourceUrl))
    })
  }

  function getAsset(data) {
    var opts = {
      url: urlUtils.resolve(
        self.apiRoot,
        '/rest/creative_asset/' + data.postFileResponse.payload.id
      ),
    }

    return self.request('get', opts).then(function (body) {
      return body.payload[0]
    })
  }

  return init(params)
    .then(getSize)
    .then(createAsset)
    .then(postFile)
    .then(getAsset)
}

module.exports = BeeswaxClient
