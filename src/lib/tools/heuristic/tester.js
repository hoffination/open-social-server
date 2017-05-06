/*jslint node: true */
// Run file with Mocha - `mocha tester.js`
var heuristic = require('./index.js');
var assert = require('assert');

/// EXPIRIMENTATION SPACE
// post
var testPost = {
  tsCreated: 1466564369016,
  votes: 0,
  comments: 0
};

console.log(heuristic.getPostHeuristic(testPost));

// event
Date.now = function() {
  return 0;
}

var testEvent = {
  tsCreated: 0,
  votes: 0,
  comments: 0,
  startDate: 48 * heuristic.ONE_HOUR
};

console.log(heuristic.getEventHeuristic(testEvent));

// rally
var testRally = {
  tsCreated: 0,
  comments: 0,
  startDate: 48 * heuristic.ONE_HOUR,
  requestCount: 0,
  declinedCount: 0
};

console.log(heuristic.getRallyHeuristic(testRally));


// content percentages
var dailyContentCount = {
  recentPosts: 80,
  upcomingEvents: 5,
  upcomingRallies: 15
};
var lowerLimits = {
  post: 0.1,
  event: 0.1,
  rally: 0.3
}
console.log(heuristic.getContentPercentages(dailyContentCount, lowerLimits));
///


// Ensure that mocha is working
describe('addition', () => {
  it('should add 1+1 correctly', done => {
    var onePlusOne = 1 + 1;
    assert.equal(onePlusOne, 2);
    // must call done() so that mocha know that we are... done.
    // Useful for async tests.
    done();
  });
});


describe('Post Heuristic', () => {
  it('a fresh post should be equal to one', done => {
    Date.now = function() {
      return 0;
    }
    var testPost = {
      tsCreated: 0,
      votes: 0,
      comments: 0
    };
    var postHeuristic = heuristic.getPostHeuristic(testPost);
    assert.equal(postHeuristic, 1);
    done();
  })

  it('a post starting with one vote should be worth two', done => {
    Date.now = function() {
      return 0;
    }
    var testPost = {
      tsCreated: 0,
      votes: 1,
      comments: 0
    };
    var postHeuristic = heuristic.getPostHeuristic(testPost);
    var expected = 2;
    assert.equal(postHeuristic, expected);
    done();
  })

  it('a post two days later with fifty two votes should be worth about one', done => {
    Date.now = function() {
      return 48 * heuristic.ONE_HOUR;
    }
    var testPost = {
      tsCreated: 0,
      votes: 52,
      comments: 0
    };
    var postHeuristic = heuristic.getPostHeuristic(testPost);
    var expected = 53 / Math.pow((48 - 11), 1.1);
    assert.equal(postHeuristic, expected);
    done();
  })
});


describe('Event Heuristic', () => {
  // it('a fresh event should be equal to zero', done => {
  //   Date.now = function() {
  //     return 0;
  //   }
  //   var testEvent = {
  //     tsCreated: 0,
  //     votes: 0,
  //     comments: 0,
  //     startDate: 48 * heuristic.ONE_HOUR,
  //     endDate: 50 * heuristic.ONE_HOUR
  //   };
  //   var postHeuristic = heuristic.getEventHeuristic(testEvent);
  //   assert.equal(postHeuristic, 0);
  //   done();
  // })
  //
  // it('an event starting with one vote should be be close to 1.4665, exactly like a post', done => {
  //   Date.now = function() {
  //     return 0;
  //   }
  //   var testEvent = {
  //     tsCreated: 0,
  //     votes: 1,
  //     comments: 0,
  //     startDate: 48 * heuristic.ONE_HOUR,
  //     endDate: 50 * heuristic.ONE_HOUR
  //   };
  //   var postHeuristic = heuristic.getEventHeuristic(testEvent);
  //   var expected = 1 / Math.pow(2, 1.1);
  //   assert.equal(postHeuristic, expected);
  //   done();
  // })
  //
  // it('an unvoted, uncommented event at the startDate should be equal to 10', done => {
  //   Date.now = function() {
  //     return 49 * heuristic.ONE_HOUR;
  //   }
  //   var testEvent = {
  //     tsCreated: 0,
  //     votes: 0,
  //     comments: 0,
  //     startDate: 48 * heuristic.ONE_HOUR,
  //     endDate: 50 * heuristic.ONE_HOUR
  //   };
  //   var postHeuristic = heuristic.getEventHeuristic(testEvent);
  //   assert.equal(postHeuristic, 10);
  //   done();
  // });
});


describe('Rally Heuristic', () => {
  it('a fresh rally should be equal to zero', done => {
    Date.now = function() {
      return 0;
    }
    var testRally = {
      tsCreated: 0,
      comments: 0,
      startDate: 48 * heuristic.ONE_HOUR,
      requestCount: 0,
      declinedCount: 0
    };
    var postHeuristic = heuristic.getRallyHeuristic(testRally);
    assert.equal(postHeuristic, 0);
    done();
  })

  it('an unrequested rally at the startDate should be equal to 10', done => {
    Date.now = function() {
      return 48 * heuristic.ONE_HOUR;
    }
    var testRally = {
      tsCreated: 0,
      comments: 0,
      startDate: 48 * heuristic.ONE_HOUR,
      requestCount: 0,
      declinedCount: 0
    };
    var postHeuristic = heuristic.getRallyHeuristic(testRally);
    assert.equal(postHeuristic, 10);
    done();
  });

  it('a rally with a 1:1 request ratio at the startDate should be equal to 20', done => {
    Date.now = function() {
      return 48 * heuristic.ONE_HOUR;
    }
    var testRally = {
      tsCreated: 0,
      comments: 0,
      startDate: 48 * heuristic.ONE_HOUR,
      requestCount: 1,
      declinedCount: 1
    };
    var postHeuristic = heuristic.getRallyHeuristic(testRally);
    assert.equal(postHeuristic, 10);
    done();
  });
});

describe('Interpolation Of values', () => {
  function getHeuristicGrouping(values) {
    return values
      .map(val => {
        let r = {};
        r[val.heuristic] = 1;
        return r;
      })
      .reduce((obj, val) => {
        var key = Object.keys(val)[0];
        if (obj[key]) {
          obj[key]++;
        } else {
          obj[key] = val[key];
        }
        return obj;
      }, {});
  }

  it('all heuristic values should not be the same if there are more than one content element of each type ' +
    'and the elements have diverse heuristics', done => {
    let values = [
      {type: 'post', heuristic: 2},
      {type: 'post', heuristic: 0.4},
      {type: 'post', heuristic: 0.0322},
      {type: 'post', heuristic: 3},
      {type: 'post', heuristic: 4},
      {type: 'event', heuristic: 7},
      {type: 'event', heuristic: 4},
      {type: 'rally', heuristic: 12.01},
    ];

    let interpolatedValues = heuristic.interpolateValues(values);
    // console.log(interpolatedValues);
    let heuristicGroups = getHeuristicGrouping(interpolatedValues)
    assert.notEqual(Object.keys(heuristicGroups).length, 1);

    values = [
      {type: 'post', heuristic: 2},
      {type: 'post', heuristic: 0.4},
      {type: 'post', heuristic: 0.0322},
      {type: 'post', heuristic: 3},
      {type: 'post', heuristic: 4},
      {type: 'rally', heuristic: 7},
      {type: 'rally', heuristic: 4},
      {type: 'event', heuristic: 12.01},
    ];

    interpolatedValues = heuristic.interpolateValues(values);
    // console.log(interpolatedValues);
    heuristicGroups = getHeuristicGrouping(interpolatedValues)
    assert.notEqual(Object.keys(heuristicGroups).length, 1);

    values = [
      {type: 'event', heuristic: 2},
      {type: 'event', heuristic: 0.4},
      {type: 'event', heuristic: 0.0322},
      {type: 'event', heuristic: 3},
      {type: 'event', heuristic: 4},
      {type: 'rally', heuristic: 7},
      {type: 'rally', heuristic: 4},
      {type: 'post', heuristic: 12.01},
    ];

    interpolatedValues = heuristic.interpolateValues(values);
    // console.log(interpolatedValues);
    heuristicGroups = getHeuristicGrouping(interpolatedValues)
    assert.notEqual(Object.keys(heuristicGroups).length, 1);
    done();
  });

  it('missing content types should not ruin the heuristic', done => {
    let values = [
      {type: 'post', heuristic: 2},
      {type: 'post', heuristic: 0.4},
      {type: 'post', heuristic: 0.0322},
      {type: 'post', heuristic: 3},
      {type: 'post', heuristic: 4},
      {type: 'event', heuristic: 4}
    ];

    let interpolatedValues = heuristic.interpolateValues(values);
    // console.log(interpolatedValues);
    let heuristicGroups = getHeuristicGrouping(interpolatedValues)
    assert.notEqual(Object.keys(heuristicGroups).length, 1);

    values = [
      {type: 'post', heuristic: 2},
      {type: 'post', heuristic: 0.4},
      {type: 'post', heuristic: 0.0322},
      {type: 'post', heuristic: 3},
      {type: 'post', heuristic: 4},
      {type: 'rally', heuristic: 7},
    ];

    interpolatedValues = heuristic.interpolateValues(values);
    // console.log(interpolatedValues);
    heuristicGroups = getHeuristicGrouping(interpolatedValues)
    assert.notEqual(Object.keys(heuristicGroups).length, 1);

    values = [
      {type: 'event', heuristic: 2},
      {type: 'event', heuristic: 0.4},
      {type: 'event', heuristic: 0.0322},
      {type: 'event', heuristic: 3},
      {type: 'event', heuristic: 4},
      {type: 'rally', heuristic: 7},
    ];

    interpolatedValues = heuristic.interpolateValues(values);
    console.log(interpolatedValues);
    heuristicGroups = getHeuristicGrouping(interpolatedValues)
    assert.notEqual(Object.keys(heuristicGroups).length, 1);
    done();
  });
});
