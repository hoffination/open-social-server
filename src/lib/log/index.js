var winston = require('winston');

// Expose `winston.transports.Logstash`
// require('winston-logstash');

// let prodOptions = {
//   port: 28777,
//   node_name: 'HA Production Server',
//   host: '104.236.172.105'
// };
//
// let devOptions = {
//   port: 28777,
//   node_name: 'Development Server',
//   host: '104.236.172.105'
// }

// winston.add(winston.transports.Logstash, process.env.ENVIRONMENT === 'PROD' ? prodOptions : devOptions);


var isWin = /^win/.test(process.platform);
var fileOptions = {
  tailable: true,
  colorize: true,
  timestamp: true,
  zippedArchive: true
};

if (process.env.ENVIRONMENT === 'PROD') {
  winston.remove(winston.transports.Console)
  winston.add(winston.transports.Console, {
    json: true,
    timestamp: true,
    stringify: true
  })
} else {
  if (!isWin) {
    fileOptions.filename = '/var/log/yo_admin.log'
  } else {
    fileOptions.filename = './yo_admin.log'
  }

  //https://github.com/winstonjs/winston/blob/master/docs/transports.md#file-transport
  winston.add(winston.transports.File, fileOptions);
}

module.exports = winston;
