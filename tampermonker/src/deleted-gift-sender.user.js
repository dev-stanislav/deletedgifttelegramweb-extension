// ==UserScript==
// @name         Deleted Gift Sender Web
// @namespace    local.deletedGiftSenderWeb
// @version      2.1.0
// @description  Deleted Gift Sender port for Telegram Web K.
// @match        https://web.telegram.org/k/*
// @run-at       document-start
// @grant        none
// @inject-into  page
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  if (window.__DGS_WEB_PORT_V21__) return;
  try {
    Object.defineProperty(window, '__DGS_WEB_PORT_V21__', {value: true});
  } catch (_) {
    window.__DGS_WEB_PORT_V21__ = true;
  }

  const TAG = '[Deleted Gift Sender Web]';
  const INSERT_POSITION = 11;
  const DEFAULT_STICKER_PACK = 'DeletedGiftsStickers';
  const REMOTE_LIST =
    'https://raw.githubusercontent.com/binbash-0/DeletedGifts-Plugin/refs/heads/main/gift_list.json';

  let deletedGifts = [
    {id:'5956217000635139069', price:50, sticker_number:1,  debug_name:'Новогодний мишка'},
    {id:'5922558454332916696', price:50, sticker_number:2,  debug_name:'Елочка'},
    {id:'5800655655995968830', price:50, sticker_number:3,  debug_name:'Мишка на 14 февраля'},
    {id:'5866352046986232958', price:50, sticker_number:4,  debug_name:'Мишка на 8 марта'},
    {id:'5801108895304779062', price:50, sticker_number:5,  debug_name:'Валентинка на 14 февраля'},
    {id:'5893356958802511476', price:50, sticker_number:6,  debug_name:'Мишка лепрекон'},
    {id:'5935895822435615975', price:50, sticker_number:7,  debug_name:'Мишка на 1 апреля'},
    {id:'5969796561943660080', price:50, sticker_number:8,  debug_name:'Мишка на пасху'},
    {id:'6026193266406327981', price:50, sticker_number:9,  debug_name:'Мишка строитель'},
    {id:'5974210632977745012', price:50, sticker_number:10, debug_name:'Мишка на чемпионате'},
    {id:'6046178578163303744', price:50, sticker_number:11, debug_name:'Мишка террорист'}
  ];

  let stickerPackName = DEFAULT_STICKER_PACK;
  let stickerDocs = null;
  let stickerLoadPromise = null;
  let stickerError = null;

  let currentAccount = null;

  let managerBridge = null;
  let customRpcSeq = 1;
  const customRpcPending = new Map();

  const pendingManagerCalls = new Map();

  function parseGiftListText(text) {
    const safe = text.replace(/("id"\s*:\s*)(\d{16,})/g, '$1"$2"');
    const data = JSON.parse(safe);

    if (!data || !Array.isArray(data.gifts) || !data.gifts.length) {
      throw new Error('invalid gift list');
    }

    const mapped = data.gifts
      .filter(x => x && x.id != null && x.price != null)
      .map(x => ({
        id: String(x.id),
        price: Number(x.price),
        sticker_number: Number(x.sticker_number || 0),
        debug_name: String(x.debug_name || x.id)
      }));

    if (!mapped.length) throw new Error('empty gift list');

    deletedGifts = mapped;
    stickerPackName = String(data.stickerpack || DEFAULT_STICKER_PACK);
    console.info(TAG, `remote list loaded: ${mapped.length} gifts`);
  }

  try {
    fetch(REMOTE_LIST, {cache: 'no-store'})
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then(parseGiftListText)
      .catch(err => console.info(TAG, 'using embedded gift list:', err?.message || err));
  } catch (_) {}

  function unwrapTasks(task, cb) {
    if (!task || typeof task !== 'object') return;

    if (task.type === 'batch' && Array.isArray(task.payload)) {
      for (const child of task.payload) unwrapTasks(child, cb);
      return;
    }

    cb(task);
  }

  function makeCustomTaskId() {
    return -(900000000 + customRpcSeq++);
  }

  function invokeManagerDirect(name, method, args, accountNumber) {
    if (!managerBridge?.sendRaw) {
      return Promise.reject(new Error('Telegram manager bridge not captured yet'));
    }

    const id = makeCustomTaskId();
    const task = {
      type: 'invoke',
      id,
      payload: {
        type: 'manager',
        payload: {
          name,
          method,
          args,
          accountNumber
        },
        void: false,
        withAck: false
      }
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        customRpcPending.delete(id);
        reject(new Error(`manager RPC timeout: ${name}.${method}`));
      }, 10000);

      customRpcPending.set(id, {
        resolve(value) {
          clearTimeout(timeout);
          customRpcPending.delete(id);
          resolve(value);
        },
        reject(error) {
          clearTimeout(timeout);
          customRpcPending.delete(id);
          reject(error);
        }
      });

      try {
        managerBridge.sendRaw(task);
      } catch (err) {
        clearTimeout(timeout);
        customRpcPending.delete(id);
        reject(err);
      }
    });
  }

  function processCustomRpcTask(task) {
    if (!task || (task.type !== 'result' && task.type !== 'ack')) return false;
    const payload = task.payload;
    if (!payload) return false;

    const pending = customRpcPending.get(payload.taskId);
    if (!pending) return false;

    if (task.type === 'ack') {
      if (!payload.cached) return true;
      if (Object.prototype.hasOwnProperty.call(payload, 'error')) {
        pending.reject(payload.error);
      } else {
        pending.resolve(payload.result);
      }
      return true;
    }

    if (Object.prototype.hasOwnProperty.call(payload, 'error')) {
      pending.reject(payload.error);
    } else {
      pending.resolve(payload.result);
    }
    return true;
  }

  function inspectOutgoing(task, port, sendRaw) {
    unwrapTasks(task, inner => {
      if (inner.type !== 'invoke') return;

      const envelope = inner.payload;
      if (!envelope || envelope.type !== 'manager') return;

      const call = envelope.payload;
      if (!call || typeof call !== 'object') return;

      managerBridge = {port, sendRaw};

      if (call.accountNumber !== undefined && call.accountNumber !== null) {
        currentAccount = call.accountNumber;
      }

      pendingManagerCalls.set(inner.id, {
        name: call.name,
        method: call.method,
        accountNumber: call.accountNumber
      });

      if (call.name === 'appGiftsManager' && call.method === 'getStarGiftOptions') {
        kickStickerLoad();
      }
    });
  }

  function kickStickerLoad(force = false) {
    if (stickerDocs?.length && !force) return Promise.resolve(stickerDocs);
    if (stickerLoadPromise && !force) return stickerLoadPromise;

    if (!managerBridge?.sendRaw) {
      stickerError = 'manager bridge not captured';
      return null;
    }

    stickerError = null;

    stickerLoadPromise = invokeManagerDirect(
      'appStickersManager',
      'getStickerSet',
      [
        stickerPackName,
        {
          overwrite: !!force,
          useCache: !force
        }
      ],
      currentAccount
    ).then(set => {
      const docs = set?.documents;

      if (!Array.isArray(docs) || !docs.length) {
        throw new Error('DeletedGiftsStickers returned no documents');
      }

      stickerDocs = docs;
      stickerError = null;

      console.info(
        TAG,
        `sticker pack "${stickerPackName}" loaded: ${docs.length} documents`
      );

      return docs;
    }).catch(err => {
      stickerError =
        err?.message ||
        err?.type ||
        String(err);

      console.warn(TAG, 'sticker pack load failed:', err);
      return null;
    }).finally(() => {
      stickerLoadPromise = null;
    });

    return stickerLoadPromise;
  }

  function chooseDonor(options, price) {
    if (!Array.isArray(options)) return null;

    const candidates = options.filter(item => {
      const raw = item?.raw;
      return raw?._ === 'starGift' && !item?.isResale;
    });

    return candidates.find(item => {
      const raw = item.raw;
      return Number(raw.stars) === Number(price) &&
        raw.availability_remains !== 0 &&
        !raw.pFlags?.sold_out &&
        !raw.pFlags?.require_premium;
    }) || candidates.find(item => {
      const raw = item.raw;
      return raw.availability_remains !== 0 &&
        !raw.pFlags?.sold_out &&
        !raw.pFlags?.require_premium;
    }) || candidates[0] || null;
  }

  function getPreviewSticker(index, fallback) {
    if (!Array.isArray(stickerDocs) || !stickerDocs.length) return fallback;

    let idx = Number(index || 0);
    if (idx >= 1) idx = Math.min(idx, stickerDocs.length - 1);
    else idx = Math.min(Math.max(0, idx), stickerDocs.length - 1);

    return stickerDocs[idx] || fallback;
  }

  function cloneRawGift(donorRaw) {
    const clone = {...donorRaw};

    if (donorRaw.pFlags && typeof donorRaw.pFlags === 'object') {
      clone.pFlags = {...donorRaw.pFlags};
    }

    if (Array.isArray(donorRaw.attributes)) {
      clone.attributes = donorRaw.attributes.slice();
    }

    return clone;
  }

  function makeInjectedGift(donor, giftDef) {
    const donorRaw = donor.raw;
    const sticker = getPreviewSticker(
      giftDef.sticker_number,
      donor.sticker || donorRaw.sticker
    );

    const raw = cloneRawGift(donorRaw);

    raw.id = String(giftDef.id);
    raw.stars = giftDef.price;
    raw.sticker = sticker;

    if (raw.pFlags) {
      delete raw.pFlags.sold_out;
      delete raw.pFlags.require_premium;
    }

    delete raw.locked_until_date;
    delete raw.per_user_total;
    delete raw.per_user_remains;
    delete raw.resell_min_stars;
    delete raw.availability_resale;

    if (raw.availability_remains === 0) {
      raw.availability_remains = 1;
    }

    return {
      type: 'stargift',
      raw,
      sticker
    };
  }

  function injectDeletedGifts(options) {
    if (!Array.isArray(options) || !options.length) return options;

    const existing = new Set(
      options
        .map(x => x?.raw?.id)
        .filter(x => x !== undefined && x !== null)
        .map(String)
    );

    const toAdd = deletedGifts.filter(g => !existing.has(String(g.id)));
    if (!toAdd.length) return options;

    const fallbackDonor = chooseDonor(options, 50);
    if (!fallbackDonor) {
      console.warn(TAG, 'no normal Star Gift donor found');
      return options;
    }

    const injected = toAdd.map(giftDef => {
      const donor = chooseDonor(options, giftDef.price) || fallbackDonor;
      return makeInjectedGift(donor, giftDef);
    });

    const at = Math.min(INSERT_POSITION, options.length);
    options.splice(at, 0, ...injected);

    console.info(
      TAG,
      `injected ${injected.length} deleted gifts; stickers=${stickerDocs?.length || 0}`
    );

    return options;
  }

  function isTrackedGiftResult(task) {
    if (!task || (task.type !== 'result' && task.type !== 'ack')) return false;

    const payload = task.payload;
    if (!payload) return false;

    const meta = pendingManagerCalls.get(payload.taskId);

    return meta?.name === 'appGiftsManager' &&
      meta?.method === 'getStarGiftOptions' &&
      Object.prototype.hasOwnProperty.call(payload, 'result');
  }

  function patchTrackedGiftResult(task) {
    const payload = task?.payload;
    if (!payload) return;

    const meta = pendingManagerCalls.get(payload.taskId);
    if (!meta) return;

    if (
      meta.name === 'appGiftsManager' &&
      meta.method === 'getStarGiftOptions' &&
      Object.prototype.hasOwnProperty.call(payload, 'result')
    ) {
      try {
        injectDeletedGifts(payload.result);
      } catch (err) {
        console.error(TAG, 'gift injection failed:', err);
      }
    }

    if (task.type === 'result' || (task.type === 'ack' && payload.cached)) {
      pendingManagerCalls.delete(payload.taskId);
    }
  }

  function makeSyntheticMessageEvent(original, data) {
    const ev = new MessageEvent('message', {data});

    try {
      Object.defineProperty(ev, 'currentTarget', {value: original.currentTarget});
      Object.defineProperty(ev, 'source', {value: original.source});
    } catch (_) {}

    return ev;
  }

  function dispatchIncomingWithPatch(listener, thisArg, event) {
    const task = event?.data;

    unwrapTasks(task, processCustomRpcTask);

    let hasGiftResult = false;
    unwrapTasks(task, inner => {
      if (isTrackedGiftResult(inner)) hasGiftResult = true;
    });

    if (!hasGiftResult) {
      return listener.call(thisArg, event);
    }

    const load = kickStickerLoad();

    if (stickerDocs?.length) {
      unwrapTasks(task, patchTrackedGiftResult);
      return listener.call(thisArg, event);
    }

    if (load) {
      if (task?.type === 'batch' && Array.isArray(task.payload)) {
        const immediate = [];
        const delayed = [];

        for (const child of task.payload) {
          if (isTrackedGiftResult(child)) delayed.push(child);
          else immediate.push(child);
        }

        if (immediate.length) {
          listener.call(
            thisArg,
            makeSyntheticMessageEvent(event, {...task, payload: immediate})
          );
        }

        Promise.race([
          Promise.resolve(load),
          new Promise(resolve => setTimeout(resolve, 5000))
        ]).finally(() => {
          for (const child of delayed) patchTrackedGiftResult(child);

          listener.call(
            thisArg,
            makeSyntheticMessageEvent(event, {...task, payload: delayed})
          );
        });

        return;
      }

      Promise.race([
        Promise.resolve(load),
        new Promise(resolve => setTimeout(resolve, 5000))
      ]).finally(() => {
        patchTrackedGiftResult(task);
        listener.call(thisArg, event);
      });

      return;
    }

    unwrapTasks(task, patchTrackedGiftResult);
    return listener.call(thisArg, event);
  }

  function installPortHooks(proto) {
    if (!proto || proto.__DGS_WEB_V21_HOOKED__) return;

    const nativePostMessage = proto.postMessage;
    const nativeAddEventListener = proto.addEventListener;
    const nativeRemoveEventListener = proto.removeEventListener;

    if (
      typeof nativePostMessage !== 'function' ||
      typeof nativeAddEventListener !== 'function' ||
      typeof nativeRemoveEventListener !== 'function'
    ) {
      return;
    }

    const listenerMaps = new WeakMap();

    try {
      Object.defineProperty(proto, '__DGS_WEB_V21_HOOKED__', {value: true});
    } catch (_) {
      proto.__DGS_WEB_V21_HOOKED__ = true;
    }

    proto.postMessage = function(message, ...rest) {
      const port = this;
      const sendRaw = (task) => nativePostMessage.call(port, task);

      try {
        inspectOutgoing(message, port, sendRaw);
      } catch (err) {
        console.warn(TAG, 'outgoing inspect failed:', err);
      }

      return nativePostMessage.call(this, message, ...rest);
    };

    proto.addEventListener = function(type, listener, options) {
      if (type !== 'message' || typeof listener !== 'function') {
        return nativeAddEventListener.call(this, type, listener, options);
      }

      let map = listenerMaps.get(this);
      if (!map) {
        map = new WeakMap();
        listenerMaps.set(this, map);
      }

      let wrapped = map.get(listener);
      if (!wrapped) {
        wrapped = function(event) {
          return dispatchIncomingWithPatch(listener, this, event);
        };
        map.set(listener, wrapped);
      }

      return nativeAddEventListener.call(this, type, wrapped, options);
    };

    proto.removeEventListener = function(type, listener, options) {
      if (type === 'message' && typeof listener === 'function') {
        const map = listenerMaps.get(this);
        const wrapped = map?.get(listener);

        if (wrapped) {
          return nativeRemoveEventListener.call(this, type, wrapped, options);
        }
      }

      return nativeRemoveEventListener.call(this, type, listener, options);
    };
  }

  try {
    installPortHooks(window.MessagePort?.prototype);
  } catch (err) {
    console.warn(TAG, 'MessagePort hook failed:', err);
  }

  try {
    installPortHooks(window.Worker?.prototype);
  } catch (err) {
    console.warn(TAG, 'Worker hook failed:', err);
  }

  window.DeletedGiftSenderWeb = {
    version: '2.1.0',

    get gifts() {
      return deletedGifts.map(x => ({...x}));
    },

    get stickerCount() {
      return stickerDocs?.length || 0;
    },

    get stickerError() {
      return stickerError;
    },

    get bridgeReady() {
      return !!managerBridge?.sendRaw;
    },

    get account() {
      return currentAccount;
    },

    reloadStickerPack() {
      stickerDocs = null;
      stickerLoadPromise = null;
      return kickStickerLoad(true);
    }
  };

  console.info(TAG, 'v2.1 loaded');
})();
