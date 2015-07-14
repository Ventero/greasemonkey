var EXPORTED_SYMBOLS = [
    'MenuCommandListRequest', 'MenuCommandRespond',
    'MenuCommandRun', 'MenuCommandSandbox',
    ];


var Cc = Components.classes;
var Ci = Components.interfaces;
var Cu = Components.utils;

// Callback from script scope, pass "list menu commands" response up to
// parent process as a message.
function MenuCommandRespond(aCookie, aData) {
  var cpmm = Cc["@mozilla.org/childprocessmessagemanager;1"]
      .getService(Ci.nsIMessageSender);
  cpmm.sendAsyncMessage(
      'greasemonkey:menu-command-response',
      {'commands': aData, 'cookie': aCookie});
}

// This function is injected into the sandbox, in a private scope wrapper, BY
// SOURCE.  Data and sensitive references are wrapped up inside its closure.
function MenuCommandSandbox(
    aScriptId, aScriptName, aCommandResponder,
    aInvalidAccesskeyErrorStr) {
  // 1) Internally to this function's private scope, maintain a set of
  // registered menu commands.
  var commands = {};
  var commandCookie = 0;
  // 4) Export the "register a command" API function to the sandbox scope.
  this.GM_registerMenuCommand = function(
      commandName, commandFunc, accessKey, unused, accessKey2) {
    // Legacy support: if all five parameters were specified, (from when two
    // were for accelerators) use the last one as the access key.
    if ('undefined' != typeof accessKey2) {
      accessKey = accessKey2;
    }

    if (accessKey
        && (("string" != typeof accessKey) || (accessKey.length != 1))
    ) {
      throw new Error(aInvalidAccesskeyErrorStr.replace('%1', commandName));
    }

    var command = {
      cookie: ++commandCookie,
      name: commandName,
      scriptId: aScriptId,
      scriptName: aScriptName,
      accessKey: accessKey,
      commandFunc: commandFunc,
    };
    commands[command.cookie] = command;
  };

  return function(cmd, detail) {
    if (cmd == 'greasemonkey:menu-command-list') {
      aCommandResponder(detail, commands)
    } else if (cmd == 'greasemonkey:menu-command-run') {
      var command = commands[detail];
      if (!command) throw new Error("nope");
      command.commandFunc.call();
    }
  }
}
