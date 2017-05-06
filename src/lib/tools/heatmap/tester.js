var heatmap = require('./index.js');
var assert = require('assert');

console.log(heatmap.getFifteenMinuteBreakdown([{startDate: Date.now(), endDate: Date.now() + (1000 * 60 * 60 * 4)}], 'startDate', 'endDate'));
console.log(heatmap.getFifteenMinuteBreakdown([{startDate: Date.now()}], 'startDate', 'startDate'));
