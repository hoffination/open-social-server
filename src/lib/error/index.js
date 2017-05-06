/*jslint node: true */
var winston = rootRequire('log');
var stackTrace = require('stack-trace');

var errorHandler = {};

/// TYPES OF ERRORS ///
// Server was unable to successfully complete request due to a runtime error
errorHandler.EXCEPTION = 'EXCEPTION';
// Server rejected request due to bad authorization
errorHandler.AUTH = 'AUTH';
// Server rejected request due to bad input in request body
errorHandler.BAD_INPUT = 'BAD_INPUT';
// Server short-circuted and rejected request due to the detection of a bad request
// * Request contained non-existent user or other missing data
errorHandler.BAD_REQUEST = 'BAD_REQUEST';
// Unable to persist requested change to the database
errorHandler.NO_CHANGE = 'NO_CHANGE'
// Unable to query database because input lacks location
errorHandler.NO_LOCATION = 'NO_LOCATION';
// Client error type
errorHandler.CLIENT_ERROR = 'CLIENT_ERROR';

errorHandler.handleErrorMessage = function handleErrorMessage(res, message, type, shouldLog) {
  if (shouldLog) {
    winston.error(message, {endpoint: shouldLog, type: type});
  }
  var responseObject = {message: message, type: type};
  try {
    if (!res.headerSent) {
      res.status(500).send(responseObject);
    }
  } catch (err) {
    winston.error(err, {type: errorHandler.EXCEPTION, endpoint: 'errorHandler:func:handleErrorMessage', trace: stackTrace.parse(err)});
  }
}

module.exports = errorHandler;
