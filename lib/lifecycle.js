'use strict';

const is = require('is-type-of');
const assert = require('assert');
const getReady = require('get-ready');
const { Ready } = require('ready-callback');
const { EventEmitter } = require('events');
const debug = require('debug')('egg-core:lifecycle');

const INIT = Symbol('Lifycycle#init');
const INIT_LOAD_READY = Symbol('Lifecycle#initLoadReady');
const INIT_BOOT_READY = Symbol('Lifecycle#initBootReady');
const DELEGATE_READY_EVENT = Symbol('Lifecycle#delegateReadyEvent');
const REGISTER_BEFORE_CLOSE = Symbol('Lifecycle#registerBeforeClose');
const REGISTER_READY_CALLBACK = Symbol('Lifecycle#registerReadyCallback');

const utils = require('./utils');

class Lifecycle extends EventEmitter {

  /**
   * @param {object} options - options
   * @param {String} options.baseDir - the directory of application
   * @param {EggCore} options.app - Application instance
   * @param {Logger} options.logger - logger
   */
  constructor(options) {
    super();
    this.options = options;
    this.bootFiles = [];
    this.boots = [];
    this.closeSet = new Set();
    this.isClose = false;
    this[INIT] = false;
    getReady.mixin(this);

    this.timing.start('Application Start');
    // get app timeout from env or use default timeout 10 second
    const eggReadyTimeoutEnv = Number.parseInt(process.env.EGG_READY_TIMEOUT_ENV || 10000);
    assert(
      Number.isInteger(eggReadyTimeoutEnv),
      `process.env.EGG_READY_TIMEOUT_ENV ${process.env.EGG_READY_TIMEOUT_ENV} should be able to parseInt.`);
    this.readyTimeout = eggReadyTimeoutEnv;

    this[INIT_LOAD_READY]();
    this
      .on('ready_stat', data => {
        this.logger.info('[egg:core:ready_stat] end ready task %s, remain %j', data.id, data.remain);
      })
      .on('ready_timeout', id => {
        this.logger.warn('[egg:core:ready_timeout] %s seconds later %s was still unable to finish.', this.readyTimeout / 1000, id);
      });

    this.ready(err => {
      this.triggerDidReady(err);
      this.timing.end('Application Start');
    });
  }

  get app() {
    return this.options.app;
  }

  get logger() {
    return this.options.logger;
  }

  get timing() {
    return this.app.timing;
  }

  legacyReadyCallback(name, opt) {
    return this.loadReady.readyCallback(name, opt);
  }

  addBootFile(file) {
    this.bootFiles.push(file);
  }

  /**
   * init boots and trigger config did config
   */
  init() {
    assert(this[INIT] === false, 'lifecycle have been init');
    this[INIT] = true;
    this.boots = this.bootFiles.map(t => new t(this.app));
    this[REGISTER_BEFORE_CLOSE]();
  }

  registerBeforeStart(scope) {
    this[REGISTER_READY_CALLBACK](scope, this.loadReady, 'Before Start');
  }

  registerBeforeClose(fn) {
    assert(is.function(fn), 'argument should be function');
    assert(this.isClose === false, 'app has been closed');
    this.closeSet.add(fn);
  }

  async close() {
    // close in reverse order: first created, last closed
    const closeFns = Array.from(this.closeSet);
    for (const fn of closeFns.reverse()) {
      await utils.callFn(fn);
      this.closeSet.delete(fn);
    }
    // Be called after other close callbacks
    this.app.emit('close');
    this.removeAllListeners();
    this.app.removeAllListeners();
    this.isClose = true;
  }

  triggerConfigDidLoad() {
    for (const boot of this.boots) {
      if (boot.configDidLoad) {
        boot.configDidLoad();
      }
    }
  }

  triggerDidLoad() {
    debug('register didLoad');
    for (const boot of this.boots) {
      const didLoad = boot.didLoad && boot.didLoad.bind(boot);
      if (didLoad) {
        this[REGISTER_READY_CALLBACK](didLoad, this.loadReady, 'Did Load');
      }
    }
    this.loadReady.ready(err => {
      debug('didLoad done');
      if (err) {
        this.ready(err);
      } else {
        this.triggerWillReady();
      }
    });
  }

  triggerWillReady() {
    debug('register willReady');
    this[INIT_BOOT_READY]();
    for (const boot of this.boots) {
      const willReady = boot.willReady && boot.willReady.bind(boot);
      if (willReady) {
        this[REGISTER_READY_CALLBACK](willReady, this.bootReady, 'Will Ready');
      }
    }
  }

  triggerDidReady(err) {
    debug('trigger didReady');
    (async () => {
      for (const boot of this.boots) {
        try {
          if (boot.didReady) {
            await boot.didReady(err);
          }
        } catch (e) {
          this.app.emit('error', e);
        }
      }
      debug('trigger didReady done');
    })();
  }

  triggerServerDidReady() {
    (async () => {
      for (const boot of this.boots) {
        try {
          await utils.callFn(boot.serverDidReady, null, boot);
        } catch (e) {
          this.emit('error', e);
        }
      }
    })();
  }

  [INIT_LOAD_READY]() {
    this.loadReady = new Ready({ timeout: this.readyTimeout });
    this[DELEGATE_READY_EVENT](this.loadReady);
    // init after didLoad
    this.bootReady = null;
  }

  [INIT_BOOT_READY]() {
    if (!this.bootReady) {
      this.bootReady = new Ready({ timeout: this.readyTimeout });
      this[DELEGATE_READY_EVENT](this.bootReady);
      this.bootReady.ready(err => {
        this.ready(err || true);
      });
    }
  }

  [DELEGATE_READY_EVENT](ready) {
    ready.once('error', err => ready.ready(err));
    ready.on('ready_timeout', id => this.emit('ready_timeout', id));
    ready.on('ready_stat', data => this.emit('ready_stat', data));
    ready.on('error', err => this.emit('error', err));
  }

  [REGISTER_BEFORE_CLOSE]() {
    for (const boot of this.boots) {
      const beforeClose = boot.beforeClose && boot.beforeClose.bind(boot);
      if (beforeClose) {
        this.registerBeforeClose(beforeClose);
      }
    }
  }

  [REGISTER_READY_CALLBACK](scope, ready, timingKeyPrefix) {
    if (!is.function(scope)) {
      throw new Error('boot only support function');
    }

    // get filename from stack
    const name = utils.getCalleeFromStack(true, 4);
    const timingkey = `${timingKeyPrefix} in ` + utils.getResolvedFilename(name, this.app.baseDir);

    this.timing.start(timingkey);

    const done = ready.readyCallback(name);

    // ensure scope executes after load completed
    process.nextTick(() => {
      utils.callFn(scope).then(() => {
        done();
        this.timing.end(timingkey);
      }, err => {
        done(err);
        this.timing.end(timingkey);
      });
    });
  }
}

module.exports = Lifecycle;