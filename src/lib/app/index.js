/*jslint node: true */
var express = require('express');
var bodyParser = require('body-parser');
var cfg = rootRequire('config');
var winston = rootRequire('log');
var cors = require('cors');
var corsOptions = {};

var app = express();

// Support JSON encoded bodies
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({extended: true}));
app.set('json spaces', 2);
app.use(cors(corsOptions));

// May need to change some of these on the dev or prod server
app.use(function(req, res, next) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST'); // TODO: how do we limit these headers on the box?
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');
  next();
});

// Include the chat module routes
app.use(rootRequire('chat'));
app.use(rootRequire('event'));
app.use(rootRequire('forum'));
app.use(rootRequire('notification'));
app.use(rootRequire('rally'));
app.use(rootRequire('search'));
app.use(rootRequire('status'));
app.use(rootRequire('user'));
app.use(rootRequire('util'));

module.exports = app;
