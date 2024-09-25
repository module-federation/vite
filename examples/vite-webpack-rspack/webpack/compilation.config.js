const printCompilationMessage = (status, port) => {
  let messageColor, messageType, browserMessage;

  switch (status) {
    case 'success':
      messageColor = '\x1b[32m';
      messageType = 'Compiled successfully!';
      browserMessage = 'You can now view';
      break;
    case 'failure':
      messageColor = '\x1b[31m';
      messageType = 'Compilation Failed!';
      browserMessage = "You can't now view";
      break;
    case 'compiling':
      messageColor = '\x1b[94m';
      messageType = 'Compiling...';
      browserMessage = 'Compiling the';
      break;
  }

  console.log(`\n\n
  ${messageColor}${messageType}\x1b[0m\n
  ${browserMessage} \x1b[1mRemote\x1b[0m in the browser.
  ${messageColor}${messageType}\x1b[0m\n
  \x1b[1mLocal\x1b[0m:  http://localhost:\x1b[1m${port}\x1b[0m
  \x1b[1mLocal\x1b[0m:  http://localhost:\x1b[1m${port}\x1b[0m\n\n
    `);
};

module.exports = printCompilationMessage;
