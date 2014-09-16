var async = require('async'),
    EventEmitter2 = require('eventemitter2').EventEmitter2,
    _ = require('underscore'),
    nodeExtend = require('node.extend'),
    fs = require('fs-extra'),

    utils = require('../public/js/utils.js'),
    Data = require('./data.js'),

    Group = require('../../../src/groups.js'),
    Meta = require('../../../src/meta.js'),
    User = require('../../../src/user.js'),
    Topics = require('../../../src/topics.js'),
    Posts = require('../../../src/posts.js'),
    Categories = require('../../../src/categories.js'),
    db = module.parent.require('../../../src/database.js'),

    IMPORT_BATCH_SIZE = 10,

    logPrefix = '[nodebb-plugin-import]',

    backupConfigFilepath = __dirname + '/tmp/importer.nbb.backedConfig.json',

    defaults = {
        log: true,
        passwordGen: {
            enabled: false,
            chars: '{}.-_=+qwertyuiopasdfghjklzxcvbnmQWERTYUIOPASDFGHJKLZXCVBNM1234567890',
            len: 13
        },
        categoriesTextColors: ['#FFFFFF'],
        categoriesBgColors: ['#ab1290','#004c66','#0059b2'],
        categoriesIcons: ['fa-comment'],
        autoConfirmEmails: true,
        userReputationMultiplier: 1,

        adminTakeOwnership: {
            enable: false,
            username: 'admin'
        },

        nbbTmpConfig: {
            postDelay: 0,
            minimumPostLength: 1,
            minimumPasswordLength: 0,
            minimumTitleLength: 1,
            maximumTitleLength: 300,
            maximumUsernameLength: 100,
            requireEmailConfirmation: 0,
            allowGuestPosting: 1
        }
    };

(function(Importer) {

    Importer._dispatcher = new EventEmitter2({
        wildcard: true
    });

    Importer.init = function(data, config, callback) {
        Importer.setup(data, config, callback);
    };

    Importer.setup = function(data, config, callback) {
        Importer._config = nodeExtend(true, {}, defaults, config && config.importer ? config.importer : config || {});
        //todo I don't like this
        Importer._config.serverLog = !!config.log.server;
        Importer._config.clientLog = !!config.log.client;
        Importer._config.verbose = !!config.log.verbose;

        Importer.emit('importer.setup.start');

        Importer.data = data || {};
        Importer.data.users = Importer.data.users || {};
        Importer.data.users._uids = Object.keys(Importer.data.users);

        Importer.data.categories = Importer.data.categories || {};
        Importer.data.categories._cids = Object.keys(Importer.data.categories);

        Importer.data.topics = Importer.data.topics || {};
        Importer.data.topics._tids = Object.keys(Importer.data.topics);

        Importer.data.posts = Importer.data.posts || {};
        Importer.data.posts._pids = Object.keys(Importer.data.posts);

        Importer.success('To be imported: '
                + Importer.data.users._uids.length + ' users, '
                + Importer.data.categories._cids.length + ' categories, '
                + Importer.data.topics._tids.length + ' topics, '
                + Importer.data.posts._pids.length + ' posts.'
        );

        Importer.dbKeys = (function() {
            return db.helpers.redis ? // if redis
                function(key, callback) {
                    return db.client.keys(key, callback);
                }
                // if mongo
                : db.helpers.mongo ?
                function(key, callback) {
                    db.client.collection('objects').find( { _key: { $regex: key.replace(/\*/, '.*') } }, function(err, result) {
                        if (err) {
                            callback(err);
                        } else {
                            result.toArray(function(err, arr) {
                                if (err) {
                                    callback(err);
                                }
                                callback(err, !err && arr && arr[0] ?
                                    Object.keys(arr[0]).map(function(v) {
                                        return key.replace(/\*/, v).replace(/\uff0E/g, '.');
                                    }) : []);
                            });
                        }
                    });
                }
                // if leveldb, keys not supported yet
                : null;
        })();

        Importer.emit('importer.setup.done');
        Importer.emit('importer.ready');
        if (_.isFunction(callback)) {
            callback();
        }
    };

    Importer.start = function(callback) {
        Importer.emit('importer.start');
        async.series([
            Importer.flushData,
            Importer.backupConfig,
            Importer.setTmpConfig,
            Importer.importCategories,
            Importer.importUsers,
            Importer.importTopics,
            Importer.importPosts,
            Importer.relockUnlockedTopics,
            Importer.fixTopicTimestamps,
            Importer.restoreConfig,
            Importer.teardown
        ], callback);
    };

    Importer.flushData = function(next) {
        async.series([
            function(done){
                Importer.phase('purgeCategories+Topics+PostsStart');
                Importer.progress(0, 1);

                Data.countCategories(function(err, total) {
                    var index = 0;
                    Data.processCategoriesCidsSet(
                        function (err, ids, nextBatch) {
                            async.mapLimit(ids, IMPORT_BATCH_SIZE, function(id, cb) {
                                Importer.progress(index++, total);
                                Categories.purge(id, cb);
                            }, nextBatch);
                        },
                        {alwaysStartAt: 0},
                        function(err) {
                            Importer.progress(1, 1);
                            Importer.phase('purgeCategories+Topics+PostsStart');
                            done(err)
                        });
                });

            },
            function(done) {
                Importer.phase('purgeUsersStart');
                Importer.progress(0, 1);

                Data.countUsers(function(err, total) {
                    var index = 0; var count = 0;
                    Data.processUsersUidsSet(
                        function(err, ids, nextBatch) {
                            async.mapLimit(ids, IMPORT_BATCH_SIZE, function(uid, cb) {
                                Importer.progress(index++, total);
                                if (parseInt(uid, 10) === 1) {
                                    return cb();
                                }
                                User.delete(uid, function() {
                                    count++;
                                    cb();
                                });
                            }, function(){
                                nextBatch();
                            });
                        },
                        {
                            // since we're deleting records the range is always shifting backwards, so need to advance the batch start boundary
                            alwaysStartAt: 0,
                            // done if the uid=1 in the only one in the db
                            doneIf: function(start, end, ids) {
                                return ids.length === 1;
                            }
                        },
                        function(err) {
                            Importer.progress(1, 1);
                            Importer.phase('purgeUsersDone');
                            done(err)
                        }
                    );
                });
            },
            function(done) {
                Importer.phase('resetGlobalsStart');
                Importer.progress(0, 1);

                async.parallel([
                    function(cb) {
                        db.setObjectField('global', 'nextUid', 1, cb);
                    },
                    function(cb) {
                        db.setObjectField('global', 'userCount', 1, cb);
                    },
                    function(cb) {
                        db.setObjectField('global', 'nextCid', 1, cb);
                    },
                    function(cb) {
                        db.setObjectField('global', 'categoryCount', 1, cb);
                    },
                    function(cb) {
                        db.setObjectField('global', 'nextTid', 1, cb);
                    },
                    function(cb) {
                        db.setObjectField('global', 'topicCount', 1, cb);
                    },
                    function(cb) {
                        db.setObjectField('global', 'nextPid', 1, cb);
                    },
                    function(cb) {
                        db.setObjectField('global', 'postCount', 1, cb);
                    }
                ], done);
            }
        ], function(err) {
            if (err) {
                Importer.error(err);
                next(err);
            }
            Importer.progress(1, 1);
            Importer.phase('resetGlobalsDone');
            next();
        });
    };

    Importer.phasePercentage = 0;

    Importer.progress = function(count, total, interval) {
        interval = interval || 2;
        var percentage = count / total * 100;
        if (percentage === 0 || percentage >= 100 || (percentage - Importer.phasePercentage > interval)) {
            Importer.phasePercentage = percentage;
            Importer.emit('importer.progress', {count: count, total: total, percentage: percentage});
        }
    };

    Importer.phase = function(phase, data) {
        Importer.phasePercentage = 0;
        Importer.emit('importer.phase', {phase: phase, data: data});
    };

    Importer.importUsers = function(next) {
        Importer._lastPercentage = 0;
        Importer.phase('usersImportStart');
        Importer.progress(0, 1);
        var count = 0,
            imported = 0,
            config = Importer.config(),
            oldOwnerNotFound = config.adminTakeOwnership.enable,
            startTime = +new Date(),
            passwordGen = config.passwordGen.enabled ?
                function() {
                    return Importer.genRandPwd(config.passwordGen.len, config.passwordGen.chars);
                } :
                function() {
                    // undefined, no password
                },
            users = Importer.data.users;

        Importer.success('Importing ' + users._uids.length + ' users.');

        async.eachLimit(users._uids, IMPORT_BATCH_SIZE, function(_uid, done) {
            count++;

            var user = users[_uid];
            var u = Importer.makeValidNbbUsername(user._username || '', user._alternativeUsername || '');
            var userData = {
                username: u.username,
                email: user._email,
                password: user._password || passwordGen()
            };

            if (!userData.username) {
                Importer.warn('[count:' + count + '] skipping user: "' + user._username + '" username is invalid.');
                return done();
            }

            Importer.log('[count: ' + count + '] saving user:_uid: ' + _uid);

            var onCreate = function(err, uid) {
                if (err) {
                    Importer.warn('[count: ' + count + '] skipping username: "' + user._username + '" ' + err);
                    done();
                } else {
                    user.imported = true;
                    imported++;

                    var onLevel = function() {

                        var fields = {
                            // preseve the signature, but Nodebb allows a max of 255 chars, so i truncate with an '...' at the end
                            signature: utils.truncateStr(user._signature || '', 252),
                            website: user._website || '',
                            banned: user._banned ? 1 : 0,
                            location: user._location || '',
                            joindate: user._joindate || startTime,
                            reputation: (user._reputation || 0) * config.userReputationMultiplier,
                            profileviews: user._profileViews || 0,
                            fullname: user._fullname || '',
                            birthday: user._birthday || '',
                            showemail: user._showemail ? 1 : 0,

                            // this is a migration script, no one is online
                            status: 'offline',

                            _imported_uid: _uid,
                            _imported_username: user._username || '',
                            _imported_slug: user._slug || user._userslug || '',
                            _imported_signature: user._signature
                        };

                        var keptPicture = false;
                        if (user._picture) {
                            fields.gravatarpicture = user._picture;
                            fields.picture = user._picture;
                            keptPicture = true;
                        }

                        var onUserFields = function(err, result) {
                            if (err) {
                                return done(err);
                            }

                            fields.uid = uid;

                            user = nodeExtend(true, {}, user, fields);
                            user.keptPicture = keptPicture;
                            user.userslug = u.userslug;

                            users[_uid] = user;

                            Importer.progress(count, users._uids.length);

                            if (config.autoConfirmEmails) {
                                db.setObjectField('email:confirmed', user.email, '1', done);
                            } else {
                                done();
                            }
                        };

                        User.setUserFields(uid, fields, onUserFields);
                    };

                    if (('' + user._level).toLowerCase() == 'moderator') {
                        Importer.makeModeratorOnAllCategories(uid, onLevel);
                        Importer.warn(userData.username + ' just became a moderator on all categories');
                    } else if (('' + user._level).toLowerCase() == 'administrator') {
                        Group.join('administrators', uid, function(){
                            Importer.warn(userData.username + ' became an Administrator');
                            onLevel();
                        });
                    } else {
                        onLevel();
                    }
                }
            };

            if (oldOwnerNotFound && (user._username || '').toLowerCase() === config.adminTakeOwnership.username.toLowerCase()) {
                Importer.warn('[count:' + count + '] skipping user: "' + user._username + '" because it was revoked ownership');

                // cache the _uid for the next phases
                Importer.config('adminTakeOwnership', {
                    enable: true,
                    username: user._username,
                    // just an alias in this case
                    _username: user._username,
                    _uid: user._uid
                });

                // no need to make it a mod or an admin, it already is
                user._level = null;

                // set to false so we don't have to match all users
                oldOwnerNotFound = false;

                // dont create, but set the fields
                return onCreate(null, 1);
            } else {
                User.create(userData, onCreate);
            }

        }, function(err) {
            if (err) {
                throw err;
            }

            Importer.success('Importing ' + imported + '/' + users._uids.length + ' users took: ' + ((+new Date() - startTime)/1000).toFixed(2) + ' seconds');

            if (config.autoConfirmEmails && Importer.dbkeys) {
                async.parallel([
                    function(done){
                        Importer.dbkeys('confirm:*', function(err, keys){
                            keys.forEach(function(key){
                                db.delete(key);
                            });
                            done();
                        });
                    },
                    function(done){
                        Importer.dbkeys('email:*:confirm', function(err, keys){
                            keys.forEach(function(key){
                                db.delete(key);
                            });
                            done();
                        });
                    }
                ], function() {
                    Importer.progress(1, 1);
                    Importer.phase('usersImportDone');
                    next();
                });
            } else {
                Importer.progress(1, 1);
                Importer.phase('usersImportDone');
                next();
            }
        });
    };

    Importer.importCategories = function(next) {
        Importer.phase('categoriesImportStart');
        Importer.progress(0, 1);

        Importer._lastPercentage = 0;
        var count = 0,
            imported = 0,
            startTime = +new Date(),
            config = Importer.config(),
            categories = Importer.data.categories;

        Importer.success('Importing ' + categories._cids.length + ' categories.');

        var onEach = function(_cid, done) {
            count++;

            var category = categories[_cid];

            Importer.log('[count:' + count + '] saving category:_cid: ' + _cid);

            var categoryData = {
                name: category._name || ('Category ' + (count + 1)),
                description: category._description || 'no description available',

                // you can fix the order later, nbb/admin
                order: category._order || count + 1,

                disabled: category._disabled || 0,

                parentCid: category._parent || category._parentCid || undefined,

                link: category._link || 0,

                // roulette, that too,
                icon: config.categoriesIcons[Math.floor(Math.random() * config.categoriesIcons.length)],
                bgColor: config.categoriesBgColors[Math.floor(Math.random() * config.categoriesBgColors.length)],
                color: config.categoriesTextColors[Math.floor(Math.random() * config.categoriesTextColors.length)]
            };

            var onCreate = function(err, categoryReturn) {
                if (err) {
                    Importer.warn('skipping category:_cid: ' + _cid + ' : ' + err);
                    return done();
                }

                var fields = {
                    _imported_cid: _cid,
                    _imported_name: category._name || '',
                    _imported_slug: category._slug || '',
                    _imported_description: category._description || '',
                    _imported_link: category._link || ''
                };

                var onFields = function(err) {
                    if (err) {
                        Importer.warn(err);
                    }

                    Importer.progress(count, categories._cids.length);

                    category.imported = true;
                    imported++;
                    category = nodeExtend(true, {}, category, categoryReturn);
                    categories[_cid] = category;
                    done();
                };

                db.setObject('category:' + categoryReturn.cid, fields, onFields);
            };

            Categories.create(categoryData, onCreate);
        };

        async.eachLimit(categories._cids, IMPORT_BATCH_SIZE, onEach, function(err) {
            if (err) {
                throw err;
            }
            Importer.success('Importing ' + imported + '/' + categories._cids.length + ' categories took: ' + ((+new Date()-startTime)/1000).toFixed(2) + ' seconds');
            Importer.progress(1, 1);
            Importer.phase('categoriesImportDone');
            next();
        });
    };

    Importer.importTopics = function(next) {
        Importer.phase('topicsImportStart');
        Importer.progress(0, 1);

        Importer._lastPercentage = 0;
        var count = 0,
            imported = 0,
            startTime = +new Date(),
            config = Importer.config(),
            users = Importer.data.users,
            categories = Importer.data.categories,
            topics = Importer.data.topics;

        Importer.success('Importing ' + topics._tids.length + ' topics.');

        var onEach = function(_tid, done) {
            count++;

            var topic = topics[_tid];
            var category = categories[topic._cid];
            var user = users[topic._uid] || {};

            if (!category || !category.imported) {
                Importer.warn('[count:' + count + '] skipping topic:_tid:"'
                    + _tid + '" --> _cid: ' + topic._cid + ':imported:' + !!(category && category.imported));

                done();
            } else {
                Importer.log('[count:' + count + '] saving topic:_tid: ' + _tid);

                var onPost = function (err, returnTopic) {
                    if (err) {
                        Importer.warn('[count:' + count + '] skipping topic:_tid: ' + _tid + ' ' + err);
                        done();
                    } else {

                        topic.imported = true;
                        imported++;

                        var timestamp = topic._timestamp || startTime;
                        var relativeTime = new Date(timestamp).toISOString();

                        var topicFields = {
                            viewcount: topic._viewcount || 0,

                            // assume that this topic not locked for now, but will iterate back again at the end and lock it back after finishing the importPosts()
                            // locked: normalizedTopic._locked ? 1 : 0,
                            locked: 0,

                            deleted: topic._deleted ? 1 : 0,

                            // if pinned, we should set the db.sortedSetAdd('categories:' + cid + ':tid', Math.pow(2, 53), tid);
                            pinned: topic._pinned ? 1 : 0,
                            timestamp: timestamp,
                            lastposttime: timestamp,

                            // todo: not sure if I need these two
                            teaser_timestamp: relativeTime,
                            relativeTime: relativeTime,

                            _imported_tid: _tid,
                            _imported_uid: topic._uid || '',
                            _imported_cid: topic._cid,
                            _imported_slug: topic._slug || '',
                            _imported_title: topic._title || '',
                            _imported_content: topic._content || ''
                        };

                        var postFields = {
                            timestamp: timestamp,
                            // todo: not sure if I need this
                            relativeTime: relativeTime
                        };

                        var onPinned = function() {

                            var onFields = function(err, result) {

                                if (err) { done(err); throw err; }

                                Importer.progress(count, topics._tids.length);

                                var onPostFields = function(){
                                    topic = nodeExtend(true, {}, topic, topicFields, returnTopic.topicData);
                                    topics[_tid] = topic;
                                    done();
                                };

                                Posts.setPostFields(returnTopic.postData.pid, postFields, onPostFields);
                            };

                            db.setObject('topic:' + returnTopic.topicData.tid, topicFields, onFields);
                        };

                        // pinned = 1 not enough to float the topic to the top in it's category
                        if (topicFields.pinned) {
                            db.sortedSetAdd('categories:' + category.cid + ':tid', Math.pow(2, 53), returnTopic.topicData.tid, onPinned);
                        }  else {
                            db.sortedSetAdd('categories:' + category.cid + ':tid', timestamp, returnTopic.topicData.tid, onPinned);
                        }
                    }
                };

                Topics.post({
                    uid: !config.adminTakeOwnership.enable ? user.uid : config.adminTakeOwnership._uid === topic._uid ? 1 : user.uid,
                    title: topic._title || '',
                    content: topic._content || '',
                    cid: category.cid,
                    thumb: topic._thumb
                }, onPost);
            }
        };

        async.eachLimit(topics._tids, IMPORT_BATCH_SIZE, onEach, function(err) {
            if (err) {
                throw err;
            }
            Importer.success('Importing ' + imported + '/' + topics._tids.length + ' topics took: ' + ((+new Date()-startTime)/1000).toFixed(2) + ' seconds');
            Importer.progress(1, 1);
            Importer.phase('topicsImportDone');
            next();
        });
    };

    Importer.importPosts = function(next) {
        Importer.phase('postsImportStart');
        Importer.progress(0, 1);

        Importer._lastPercentage = 0;
        var count = 0,
            imported = 0,
            startTime = +new Date(),
            config = Importer.config(),
            users = Importer.data.users,
            topics = Importer.data.topics,
            posts = Importer.data.posts;

        Importer.success('Importing ' + posts._pids.length + ' posts.');

        var onEach = function(_pid, done) {
            count++;

            var post = posts[_pid];
            var topic = topics[post._tid];
            var user = users[post._uid] || {};

            if (!topic || !topic.imported) {
                Importer.warn('skipping post:_pid: ' + _pid + ' _tid:valid: ' + !!(topic && topic.imported));
                done();
            } else {

                Importer.log('[count: ' + count + '] saving post: ' + _pid);

                var onCreate = function(err, postReturn){
                    if (err) {
                        Importer.warn('[count: ' + count + '] skipping post: ' + post._pid + ' ' + err);
                        done();
                    } else {

                        post.imported = true;
                        imported++;

                        var fields = {
                            reputation: post._reputation || 0,
                            votes: post._votes || 0,
                            edited: post._edited || 0,
                            deleted: post._deleted || 0,

                            // todo: not sure if I need this
                            relativeTime: new Date(post._timestamp || startTime).toISOString(),

                            _imported_pid: _pid,
                            _imported_uid: post._uid || '',
                            _imported_tid: post._tid || '',
                            _imported_content: post._content || ''
                        };

                        var onPostFields = function() {

                            Importer.progress(count, posts._pids.length);

                            post = nodeExtend(true, {}, post, fields, postReturn);
                            post.imported = true;
                            posts[_pid] = post;
                            done();
                        };

                        Posts.setPostFields(postReturn.pid, fields, onPostFields);
                    }
                };

                Posts.create({
                    uid: !config.adminTakeOwnership.enable ? user.uid : config.adminTakeOwnership._uid === post._uid ? 1 : user.uid,
                    tid: topic.tid,
                    content: post._content || '',
                    timestamp: post._timestamp || startTime,

                    // i seriously doubt you have this, but it's ok if you don't
                    toPid: post['_nbb-toPid']

                }, onCreate);
            }
        };

        async.eachLimit(posts._pids, IMPORT_BATCH_SIZE, onEach, function() {
            Importer.progress(1, 1);
            Importer.phase('postsImportDone');
            Importer.success('Importing ' + imported + '/' + posts._pids.length + ' posts took: ' + ((+new Date()-startTime)/1000).toFixed(2) + ' seconds');
            next();
        });
    };

    Importer.teardown = function(next) {
        Importer.phase('importerTeardownStart');
        Importer.phase('importerTeardownDone');
        Importer.phase('importerComplete');

        Importer.emit('importer.complete');
        next();
    };

    Importer.relockUnlockedTopics = function(next) {
        var count = 0, len = Importer.data.topics._tids.length;

        Importer.phase('relockingTopicsStart');
        Importer.progress(0, 1);

        async.eachLimit(Importer.data.topics._tids, IMPORT_BATCH_SIZE, function(_tid, done) {
            var topic = Importer.data.topics[_tid];
            Importer.progress(count++, len);

            if (!topic) {
                Importer.warn('[count:' + count + '] imported topic:_tid: ' + _tid + ' doesn\'t exist in storage, probably skipped some time earlier');
                done();
            } else {
                if (topic._locked) {
                    db.setObjectField('topic:' + topic.tid, 'locked', '1', function(err) {
                        if (err) {
                            Importer.warn(err);
                        } else {
                            Importer.log('[count: ' + count + '] locked topic:' + topic.tid + ' back');
                        }
                        done();
                    });
                } else {
                    done();
                }
            }
        }, function(err) {
            if (err) throw err;
            Importer.progress(1, 1);
            Importer.phase('relockingTopicsDone');
            next();
        });
    };

    Importer.fixTopicTimestamps = function(next) {
        var count = 0, len = Importer.data.topics._tids.length;

        Importer.phase('fixTopicTimestampsStart');
        Importer.progress(0, 1);

        async.eachLimit(Importer.data.topics._tids, IMPORT_BATCH_SIZE, function(_tid, done) {
            var topic = Importer.data.topics[_tid];
            Importer.progress(count++, len);

            if (topic && topic.tid) {
                db.getSortedSetRevRange('tid:' + topic.tid + ':posts', 0, -1, function(err, pids) {
                    if (err) {
                        return done(err);
                    }

                    if (!Array.isArray(pids) || !pids.length) {
                        return done();
                    }
                    async.parallel({
                        cid: function(next) {
                            db.getObjectField('topic:' + topic.tid, 'cid', next);
                        },
                        lastPostTimestamp: function(next) {
                            db.getObjectField('post:' + pids[0], 'timestamp', next);
                        }
                    }, function(err, results) {
                        if (err) {
                            return done(err);
                        }

                        db.sortedSetAdd('categories:' + results.cid + ':tid', results.lastPostTimestamp, topic.tid, done);
                    });
                });
            } else {
                done();
            }
        }, function(err) {
            if (err) throw err;
            Importer.progress(1, 1);
            Importer.phase('fixTopicTimestampsDone');
            next();
        });
    };

    Importer.backupConfig = function(next) {
        // if the backedConfig file exists, that means we did not complete the restore config last time,
        // so don't overwrite it, assuming the nodebb config in the db are the tmp ones
        if (fs.existsSync(backupConfigFilepath)) {
            Importer.config('backedConfig', fs.readJsonSync(backupConfigFilepath) || {});
            next();
        } else {
            db.getObject('config', function(err, data) {
                if (err) {
                    throw err;
                }
                Importer.config('backedConfig', data || {});
                fs.outputJsonSync(backupConfigFilepath, Importer.config('backedConfig'));
                next();
            });
        }
    };

    Importer.setTmpConfig = function(next) {
        // get the nbb backedConfigs, change them, then set them back to the db
        // just to make the transition a little less flexible
        // yea.. i dont know .. i have a bad feeling about this
        var config = nodeExtend(true, {}, Importer.config().backedConfig, Importer.config().nbbTmpConfig);

        // if you want to auto confirm email, set the host to null, if there is any
        // this will prevent User.sendConfirmationEmail from setting expiration time on the email address
        // per https://github.com/designcreateplay/NodeBB/blob/master/src/user.js#L458'ish
        if (Importer.config().autoConfirmEmails) {
            config['email:smtp:host'] = '';
        }

        db.setObject('config', config, function(err){
            if (err) {
                throw err;
            }

            Meta.configs.init(next);
        });
    };

    // im nice
    Importer.restoreConfig = function(next) {
        if (fs.existsSync(backupConfigFilepath)) {
            Importer.config('backedConfig', fs.readJsonFileSync(backupConfigFilepath));

            db.setObject('config', Importer.config().backedConfig, function(err){
                if (err) {
                    Importer.warn('Something went wrong while restoring your nbb configs');
                    Importer.warn('here are your backed-up configs, you do it manually');
                    Importer.warn(JSON.stringify(Importer.config().backedConfig));
                    return next();
                }

                Importer.success('Config restored:' + JSON.stringify(Importer.config().backedConfig));
                fs.removeSync(backupConfigFilepath);

                Meta.configs.init(function(err) {
                    if (err) {
                        Importer.warn('Could not re-init Meta configs, just restart NodeBB, you\'ll be fine');
                    }

                    next();
                });
            });
        } else {
            Importer.warn('Could not restore NodeBB tmp configs, because ' + backupConfigFilepath + ' does not exist');
            next();
        }
    };

    // aka forums
    Importer.makeModeratorOnAllCategories = function(uid, done) {
        async.map(Importer.data.categories._cids, function(cid, next) {
            var category = Importer.data.categories[cid];
            if (category) {
                Group.join('group:cid:' + cid + ':privileges:mods:members', uid, function(err){
                    if (err) {
                        Importer.warn(err);
                    }
                    next();
                });
            }
        }, done);
    };

    // which of the values is falsy
    Importer.whichIsFalsy = function(arr){
        for (var i = 0; i < arr.length; i++) {
            if (!arr[i])
                return i;
        }
        return null;
    };

    // a helper method to generate temporary passwords
    Importer.genRandPwd = function(len, chars) {
        var index = (Math.random() * (chars.length - 1)).toFixed(0);
        return len > 0 ? chars[index] + Importer.genRandPwd(len - 1, chars) : '';
    };

    // todo: i think I got that right?
    Importer.cleanUsername = function(str) {
        str = str.replace(/[^\u00BF-\u1FFF\u2C00-\uD7FF\-.*\w\s]/gi, '');
        // todo: i don't know what I'm doing HALP
        return str.replace(/ /g,'').replace(/\*/g, '').replace(/æ/g, '').replace(/ø/g, '').replace(/å/g, '');
    };

    // todo: holy fuck clean this shit
    Importer.makeValidNbbUsername = function(_username, _alternativeUsername) {
        var _userslug = utils.slugify(_username || '');

        if (utils.isUserNameValid(_username) && _userslug) {
            return {username: _username, userslug: _userslug};

        } else {
            var username = Importer.cleanUsername(_username);
            var userslug = utils.slugify(username);

            if (utils.isUserNameValid(username) && userslug) {
                return {username: username, userslug: userslug};

            } else if (_alternativeUsername) {

                var _alternativeUsernameSlug = utils.slugify(_alternativeUsername);

                if (utils.isUserNameValid(_alternativeUsername) && _alternativeUsernameSlug) {
                    return {username: _alternativeUsername, userslug: _alternativeUsernameSlug};

                } else {

                    var alternativeUsername = Importer.cleanUsername(_alternativeUsername);
                    var alternativeUsernameSlug = utils.slugify(alternativeUsername);

                    if (utils.isUserNameValid(alternativeUsername) && alternativeUsernameSlug) {
                        return {username: alternativeUsername, userslug: alternativeUsernameSlug};
                    } else {
                        return {username: null, userslug: null};
                    }
                }
            } else {
                return {username: null, userslug: null};
            }
        }
    };

    Importer.emit = function () {
        var args = Array.prototype.slice.call(arguments, 0);

        if (args && args[args.length - 1] !== 'logged') {
            Importer.log.apply(Importer, args);
        } else {
            args.pop();
        }

        args.unshift(args[0]);
        Importer._dispatcher.emit.apply(Importer._dispatcher, args);
    };

    Importer.on = function () {
        Importer._dispatcher.on.apply(Importer._dispatcher, arguments);
    };

    Importer.once = function () {
        Importer._dispatcher.once.apply(Importer._dispatcher, arguments);
    };

    Importer.removeAllListeners = function () {
        Importer._dispatcher.removeAllListeners();
    };

    Importer.warn = function() {
        var args = _.toArray(arguments);

        args.unshift('importer.warn');
        args.push('logged');
        Importer.emit.apply(Importer, args);
        args.unshift(logPrefix);
        args.pop();

        console.warn.apply(console, args);
    };

    Importer.log = function() {
        if (!Importer.config.verbose) {
            return;
        }

        var args = _.toArray(arguments);

        args.unshift('importer.log');
        args.push('logged');
        if (Importer.config.clientLog) {
            Importer.emit.apply(Importer, args);
        }
        args.unshift(logPrefix);
        args.pop();
        if (Importer.config.serverLog) {
            console.log.apply(console, args);
        }
    };

    Importer.success = function() {
        var args = _.toArray(arguments);

        args.unshift('importer.success');
        args.push('logged');
        Importer.emit.apply(Importer, args);
        args.unshift(logPrefix);
        args.pop();

        console.log.apply(console, args);
    };

    Importer.error = function() {
        var args = _.toArray(arguments);

        args.unshift('importer.error');
        args.push('logged');
        Importer.emit.apply(Importer, args);
        args.unshift(logPrefix);
        args.pop();

        console.error.apply(console, args);
    };

    Importer.config = function(config, val) {
        if (config != null) {
            if (typeof config === 'object') {
                Importer._config = config;
            } else if (typeof config === 'string') {
                if (val != null) {
                    Importer._config = Importer._config || {};
                    Importer._config[config] = val;
                }
                return Importer._config[config];
            }
        }
        return Importer._config;
    };

})(module.exports);
