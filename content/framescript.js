let {utils: Cu, interfaces: Ci, classes: Cc} = Components;

Cu.import('resource://gre/modules/Services.jsm');

Cu.import('resource://greasemonkey/GM_setClipboard.js');
Cu.import('resource://greasemonkey/miscapis.js');
Cu.import('resource://greasemonkey/util.js');

// Only a particular set of strings are allowed.  See: http://goo.gl/ex2LJ
var gMaxJSVersion = "ECMAv5";

var gIoService = Services.io;
var gStringBundle = Services.strings.createBundle(
  "chrome://greasemonkey/locale/greasemonkey.properties");

function createSandbox(aScript, aContentWin) {
  if (GM_util.inArray(aScript.grants, 'none')) {
    // If there is an explicit none grant, use a plain unwrapped sandbox
    // with no other content.
    var contentSandbox = new Components.utils.Sandbox(
        aContentWin,
        {
          'sandboxName': aScript.id,
          'sandboxPrototype': aContentWin,
          'wantXrays': false,
        });
    // GM_info is always provided.
    Components.utils.evalInSandbox(
        'const GM_info = ' + uneval(aScript.info()), contentSandbox);
    // Alias unsafeWindow for compatibility.
    Components.utils.evalInSandbox(
        'const unsafeWindow = window;', contentSandbox);

    return contentSandbox;
  }

  var sandbox = new Components.utils.Sandbox(
      [aContentWin],
      {
        'sandboxName': aScript.id,
        'sandboxPrototype': aContentWin,
        'wantXrays': true,
      });

  // Note that because waivers aren't propagated between origins, we need the
  // unsafeWindow getter to live in the sandbox.  See http://bugzil.la/1043958
  var unsafeWindowGetter = new sandbox.Function(
      'return window.wrappedJSObject || window;');
  Object.defineProperty(sandbox, 'unsafeWindow', {get: unsafeWindowGetter});

  // Functions for interaction with unsafeWindow; see: http://goo.gl/C8Au16
  sandbox.createObjectIn = Cu.createObjectIn;
  sandbox.cloneInto = Cu.cloneInto;
  sandbox.exportFunction = Cu.exportFunction;


  if (GM_util.inArray(aScript.grants, 'GM_addStyle')) {
    sandbox.GM_addStyle = GM_util.hitch(null, GM_addStyle, aContentWin.document);
  }

  if (GM_util.inArray(aScript.grants, 'GM_log')) {
    sandbox.GM_log = GM_util.hitch(new GM_ScriptLogger(aScript), 'log');
  }

  // TODO: needs IPC, handle similar to pendingExec?
  // if (GM_util.inArray(aScript.grants, 'GM_registerMenuCommand')) {
  //   var gmrmc = GM_util.hitch(
  //       null, registerMenuCommand, aContentWin, aScript);
  //   sandbox.GM_registerMenuCommand = gmrmc;
  // }

  var scriptStorage = new GM_ScriptStorage(aScript);
  if (GM_util.inArray(aScript.grants, 'GM_deleteValue')) {
    sandbox.GM_deleteValue = GM_util.hitch(scriptStorage, 'deleteValue');
  }
  if (GM_util.inArray(aScript.grants, 'GM_getValue')) {
    sandbox.GM_getValue = GM_util.hitch(scriptStorage, 'getValue');
  }
  if (GM_util.inArray(aScript.grants, 'GM_setValue')) {
    sandbox.GM_setValue = GM_util.hitch(scriptStorage, 'setValue');
  }
  if (GM_util.inArray(aScript.grants, 'GM_listValues')) {
    sandbox.GM_listValues = GM_util.hitch(scriptStorage, 'listValues');
  }

  if (GM_util.inArray(aScript.grants, 'GM_setClipboard')) {
    sandbox.GM_setClipboard = GM_util.hitch(null, GM_setClipboard);
  }

  var scriptResources = new GM_Resources(aScript);
  if (GM_util.inArray(aScript.grants, 'GM_getResourceURL')) {
    sandbox.GM_getResourceURL = GM_util.hitch(scriptResources, 'getResourceURL', aScript);
  }
  if (GM_util.inArray(aScript.grants, 'GM_getResourceText')) {
    sandbox.GM_getResourceText = GM_util.hitch(scriptResources, 'getResourceText');
  }

  // TODO: getChromeWinForContentWin
  // if (GM_util.inArray(aScript.grants, 'GM_openInTab')) {
  //   sandbox.GM_openInTab = GM_util.hitch(
  //       null, GM_openInTab, aContentWin);
  // }

  // TODO: requires chrome window
  // if (GM_util.inArray(aScript.grants, 'GM_xmlhttpRequest')) {
  //   sandbox.GM_xmlhttpRequest = GM_util.hitch(
  //       new GM_xmlhttpRequester(aContentWin, aChromeWin, aUrl, sandbox),
  //       'contentStartRequest');
  // }

  Components.utils.evalInSandbox(
      'const GM_info = ' + uneval(aScript.info()), sandbox);

  return sandbox;
}

function runScriptInSandbox(script, sandbox) {
  // Eval the code, with anonymous wrappers when/if appropriate.
  function evalWithWrapper(code, fileName) {
    try {
      Cu.evalInSandbox(code, sandbox, gMaxJSVersion, fileName, 1);
    } catch (e) {
      if ("return not in function" == e.message) {
        // See #1592; we never anon wrap anymore, unless forced to by a return
        // not in a function.
        GM_util.logError(
            gStringBundle.GetStringFromName('return-not-in-func-deprecated'),
            true, // is a warning
            fileName,
            e.lineNumber
            );
        Components.utils.evalInSandbox(
            GM_util.anonWrap(code), sandbox, gMaxJSVersion, fileName, 1);
      } else {
        // Otherwise raise.
        throw e;
      }
    }
  }

  // Eval the code, with a try/catch to report errors cleanly.
  function evalWithCatch(code, fileName) {
    try {
      evalWithWrapper(code, fileName);
    } catch (e) {
      // Log it properly.
      GM_util.logError(e, false, fileName, e.lineNumber);
      // Stop the script, in the case of requires, as if it was one big script.
      return false;
    }
    return true;
  }

  for (var i = 0, require = null; require = script.requires[i]; i++) {
    if (!evalWithCatch(require.textContent, require.fileURL)) {
      return;
    }
  }

  evalWithCatch(script.textContent, script.fileURL);
}

var observer = {
  observe: function(aSubject, aTopic, aData) {
    if (!GM_util.getEnabled()) return;

    switch (aTopic) {
      case 'document-element-inserted':
        var doc = aSubject;
        var win = doc && doc.defaultView;

        if (!doc || !win) break;

        this.runScripts('document-start', win);
        break;
      default:
        dump("received unknown topic: ", aTopic);
    }
  },

  contentLoad: function(aEvent) {
    var contentWin = aEvent.target.defaultView;
    this.runScripts('document-end', contentWin);
  },

  runScripts: function(aRunWhen, aWrappedContentWin) {
    if (!GM_util.isGreasemonkeyable(aWrappedContentWin.document.documentURI))
      return;

    // TODO: probably remove, or move to isGreasemonkeyable or something
    try {
      aWrappedContentWin.QueryInterface(Ci.nsIDOMChromeWindow);
      return;
    } catch(e) {
    }

    this.windowId = GM_util.windowId(aWrappedContentWin);

    sendAsyncMessage('greasemonkey:run-scripts', {
      'url': aWrappedContentWin.document.documentURI,
      'when': aRunWhen,
      'windowId': this.windowId
    });
  },

  injectScripts: function(aMessage) {
    if (!this.windowId || this.windowId !== aMessage.data.windowId)
      return;

    var scripts = aMessage.objects.scripts;
    for (var i = 0, script = null; script = scripts[i]; i++) {
      // TODO: can we just use content here?
      var sandbox = createSandbox(script, content);
      runScriptInSandbox(script, sandbox);
    }
  }
}

Services.obs.addObserver(observer, 'document-element-inserted', false);
addEventListener('DOMContentLoaded', observer.contentLoad.bind(observer));
addEventListener('load', observer.contentLoad.bind(observer));
addMessageListener('greasemonkey:inject-scripts', observer.injectScripts.bind(observer));
