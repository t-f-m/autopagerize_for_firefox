var contextMenu = require('context-menu')
var pageMod = require('page-mod')
var self = require('self')
var xhr = require('xhr')
var localStorage = require('simple-storage').storage
var panels = require('panel')
var tabs = require('tabs')
var url = require('url')

var SITEINFO_IMPORT_URLS = [
    'http://wedata.net/databases/AutoPagerize/items.json',
]
var CACHE_EXPIRE = 24 * 60 * 60 * 1000
var siteinfo = {}
var launched = {}
// var settings = {}

xhr.XMLHttpRequest.prototype.__defineGetter__(
    'finalURL',
    function() {
        return this._req.channel.URI.spec
    })

exports.main = function (options, callbacks) {
    if (!localStorage['settings']) {
        var defaultSettings = {
            // extension_path: self.data.url(''),
            loading_html: self.data.load('loading.html.data'),
            error_html: self.data.load('error.html.data'),
            display_message_bar: true,
            exclude_patterns: localStorage['exclude_patterns'] || ''
        }
        localStorage['settings'] = JSON.stringify(defaultSettings)
    }

    loadLocalSiteinfoCallback(JSON.parse(self.data.load('items.json')))

    pageMod.PageMod({
        include: ['http://*', 'https://*'],
        contentScriptWhen: 'ready',
        contentScript: self.data.load('extension.js') + ';' +
            self.data.load('autopagerize.user.js'),
        onAttach: onAttach
    })

    contextMenu.Menu({
        label: "AutoPagerize",
        context: contextMenu.PageContext(),
        contentScript: self.data.load('context_menu.js'),
        items: [
            contextMenu.Item({ label: "on/off", data: "toggle" }),
            contextMenu.Item({ label: "config", data: "config" })
        ],
        onMessage: function (message) {
            configPanel.show()
        }
    })

    var configPanel = panels.Panel({
        width: 700,
        height: 500,
        contentURL: self.data.url("options.html"),
        contentScriptFile: self.data.url("options.js"),
        contentScriptWhen: "ready",
        onShow: function() {
            configPanel.postMessage({ name: 'onshow' })
        },
        onMessage: function(message) {
            if (message.name == 'settings') {
                configPanel.postMessage({ name: message.name, data: JSON.parse(localStorage['settings']) })
            }
            else if (message.name == 'settingsUpdate') {
                localStorage['settings'] = JSON.stringify(message.data)
                configPanel.hide()

                var cs = "var ev = document.createEvent('Event');" +
                    "ev.initEvent('AutoPagerizeUpdateSettingsRequest', true, false);" +
                    "document.dispatchEvent(ev);"
                for (var i in tabs) {
                    tabs[i].attach({ contentScript: cs })
                }
            }
            else if (message.name == 'siteinfo_meta') {
                var u = SITEINFO_IMPORT_URLS[0]
                var len = siteinfo[u].info.length
                var updated_at = siteinfo[u].expire - CACHE_EXPIRE
                configPanel.postMessage({ name: message.name, len: len, updated_at: updated_at })
            }
            else if (message.name == 'update_siteinfo') {
                refreshSiteinfo({ force: true, callback: function() {
                    configPanel.postMessage({ name: message.name, res: 'ok' })
                }})
            }
        }
    })
}

function onAttach(worker) {
    worker.on('error', function(error) {
        console.error(error.message)
    })
    worker.on('message', function(message) {
        if (message.name == 'settings') {
            var res = JSON.parse(localStorage['settings'])
            worker.postMessage({ name: 'settings', data: res })
        }
        else if (message.name == 'siteinfo') {
            var res = SITEINFO_IMPORT_URLS.reduce(function(r, url) {
                return r.concat(siteinfo[url].info)
            }, []).filter(function(s) {
                return message.data.url.match(s.url)
            })
            worker.postMessage({ name: 'siteinfo', data: res })
        }
        else if (message.name == 'launched') {
            launched[message.data.url] = true
        }
        else if (message.name == 'get') {
            get(message.data.url, function(res) {
                var issame = isSameOrigin(message.data.fromURL,
                                          res.finalURL)
                var d = {
                    responseText : issame ? res.responseText : null,
                    finalURL : res.finalURL
                }
                worker.postMessage({ name: 'get', data: d })
            }, { charset: message.data.charset })
        }
        else {
            console.log('else')
        }
    })
}

function loadLocalSiteinfoCallback(data) {
    var url = 'http://wedata.net/databases/AutoPagerize/items.json'
    var cache = JSON.parse(localStorage['cacheInfo'] || '{}')
    if (!cache[url]) {
        siteinfo[url] = {
            url: url,
            expire: new Date().getTime() - 1,
            info: reduceWedataJSON(data)
        }
        cache[url] = siteinfo[url]
        localStorage['cacheInfo'] = JSON.stringify(cache)
    }
    else {
        siteinfo[url] = cache[url]
    }
    refreshSiteinfo()
}

function reduceWedataJSON(data) {
    var r_keys = ['url', 'nextLink', 'insertBefore', 'pageElement']
    var info = data.map(function(i) {
        return i.data
    }).filter(function(i) {
        return ('url' in i)
    })
    if (info.length == 0) {
        return []
    }
    else {
        info.sort(function(a, b) {
            return (b.url.length - a.url.length)
        })
        return info.map(function(i) {
            var item = {}
            r_keys.forEach(function(key) {
                if (i[key]) {
                    item[key] = i[key]
                }
            })
            return item
        })
    }
}

function refreshSiteinfo(opt) {
    var opt = opt || {}
    var cache = JSON.parse(localStorage['cacheInfo'] || '{}')
    SITEINFO_IMPORT_URLS.forEach(function(url) {
        if (opt.force || !cache[url] || (cache[url].expire && new Date(cache[url].expire) < new Date())) {
            var callback = function(res) {
                if (res.status != 200) {
                    return
                }
                var info = reduceWedataJSON(JSON.parse(res.responseText))
                if (info.length == 0) {
                    return
                }
                siteinfo[url] = {
                    url: url,
                    expire: new Date().getTime() + CACHE_EXPIRE,
                    info: info
                }
                cache[url] = siteinfo[url]
                localStorage['cacheInfo'] = JSON.stringify(cache)
                if (opt.callback) {
                    opt.callback()
                }
            }
            try {
                get(url, callback)
            }
            catch(e) {
                console.log(e)
            }
        }
    })
}

function get(url, callback, opt) {
    var opt = opt || {}
    var req = new xhr.XMLHttpRequest()
    req.onreadystatechange = function() {
        if (req.readyState == 4) {
            callback(req)
        }
    }
    req.open('GET', url, true)
    if (opt.charset) {
        req.overrideMimeType('text/html; charset=' + opt.charset)
    }
    req.send(null)
    return req
}

function isSameOrigin(url1, url2) {
    var a = new url.URL(url1)
    var b = new url.URL(url2)
    return (a.scheme && a.scheme && a.host == b.host &&
            a.port == b.port)
}
