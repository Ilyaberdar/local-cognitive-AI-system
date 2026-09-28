function Jd(g) {
  return g && g.__esModule && Object.prototype.hasOwnProperty.call(g, "default") ? g.default : g;
}
var Wf = { exports: {} }, vu = {};
/**
 * @license React
 * react-jsx-runtime.production.js
 *
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
var Ld;
function fh() {
  if (Ld) return vu;
  Ld = 1;
  var g = Symbol.for("react.transitional.element"), R = Symbol.for("react.fragment");
  function N(r, J, at) {
    var I = null;
    if (at !== void 0 && (I = "" + at), J.key !== void 0 && (I = "" + J.key), "key" in J) {
      at = {};
      for (var V in J)
        V !== "key" && (at[V] = J[V]);
    } else at = J;
    return J = at.ref, {
      $$typeof: g,
      type: r,
      key: I,
      ref: J !== void 0 ? J : null,
      props: at
    };
  }
  return vu.Fragment = R, vu.jsx = N, vu.jsxs = N, vu;
}
var Gd;
function sh() {
  return Gd || (Gd = 1, Wf.exports = fh()), Wf.exports;
}
var kh = sh(), If = { exports: {} }, Eu = {}, Ff = { exports: {} }, Pf = {};
/**
 * @license React
 * scheduler.production.js
 *
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
var qd;
function oh() {
  return qd || (qd = 1, function(g) {
    function R(p, U) {
      var x = p.length;
      p.push(U);
      t: for (; 0 < x; ) {
        var et = x - 1 >>> 1, ft = p[et];
        if (0 < J(ft, U))
          p[et] = U, p[x] = ft, x = et;
        else break t;
      }
    }
    function N(p) {
      return p.length === 0 ? null : p[0];
    }
    function r(p) {
      if (p.length === 0) return null;
      var U = p[0], x = p.pop();
      if (x !== U) {
        p[0] = x;
        t: for (var et = 0, ft = p.length, o = ft >>> 1; et < o; ) {
          var _ = 2 * (et + 1) - 1, C = p[_], q = _ + 1, lt = p[q];
          if (0 > J(C, x))
            q < ft && 0 > J(lt, C) ? (p[et] = lt, p[q] = x, et = q) : (p[et] = C, p[_] = x, et = _);
          else if (q < ft && 0 > J(lt, x))
            p[et] = lt, p[q] = x, et = q;
          else break t;
        }
      }
      return U;
    }
    function J(p, U) {
      var x = p.sortIndex - U.sortIndex;
      return x !== 0 ? x : p.id - U.id;
    }
    if (g.unstable_now = void 0, typeof performance == "object" && typeof performance.now == "function") {
      var at = performance;
      g.unstable_now = function() {
        return at.now();
      };
    } else {
      var I = Date, V = I.now();
      g.unstable_now = function() {
        return I.now() - V;
      };
    }
    var z = [], E = [], j = 1, H = null, Z = 3, ut = !1, rt = !1, F = !1, Mt = !1, ht = typeof setTimeout == "function" ? setTimeout : null, Ht = typeof clearTimeout == "function" ? clearTimeout : null, Nt = typeof setImmediate < "u" ? setImmediate : null;
    function jt(p) {
      for (var U = N(E); U !== null; ) {
        if (U.callback === null) r(E);
        else if (U.startTime <= p)
          r(E), U.sortIndex = U.expirationTime, R(z, U);
        else break;
        U = N(E);
      }
    }
    function St(p) {
      if (F = !1, jt(p), !rt)
        if (N(z) !== null)
          rt = !0, pt || (pt = !0, ne());
        else {
          var U = N(E);
          U !== null && me(St, U.startTime - p);
        }
    }
    var pt = !1, tt = -1, qt = 5, Qt = -1;
    function Ge() {
      return Mt ? !0 : !(g.unstable_now() - Qt < qt);
    }
    function ge() {
      if (Mt = !1, pt) {
        var p = g.unstable_now();
        Qt = p;
        var U = !0;
        try {
          t: {
            rt = !1, F && (F = !1, Ht(tt), tt = -1), ut = !0;
            var x = Z;
            try {
              e: {
                for (jt(p), H = N(z); H !== null && !(H.expirationTime > p && Ge()); ) {
                  var et = H.callback;
                  if (typeof et == "function") {
                    H.callback = null, Z = H.priorityLevel;
                    var ft = et(
                      H.expirationTime <= p
                    );
                    if (p = g.unstable_now(), typeof ft == "function") {
                      H.callback = ft, jt(p), U = !0;
                      break e;
                    }
                    H === N(z) && r(z), jt(p);
                  } else r(z);
                  H = N(z);
                }
                if (H !== null) U = !0;
                else {
                  var o = N(E);
                  o !== null && me(
                    St,
                    o.startTime - p
                  ), U = !1;
                }
              }
              break t;
            } finally {
              H = null, Z = x, ut = !1;
            }
            U = void 0;
          }
        } finally {
          U ? ne() : pt = !1;
        }
      }
    }
    var ne;
    if (typeof Nt == "function")
      ne = function() {
        Nt(ge);
      };
    else if (typeof MessageChannel < "u") {
      var qe = new MessageChannel(), oe = qe.port2;
      qe.port1.onmessage = ge, ne = function() {
        oe.postMessage(null);
      };
    } else
      ne = function() {
        ht(ge, 0);
      };
    function me(p, U) {
      tt = ht(function() {
        p(g.unstable_now());
      }, U);
    }
    g.unstable_IdlePriority = 5, g.unstable_ImmediatePriority = 1, g.unstable_LowPriority = 4, g.unstable_NormalPriority = 3, g.unstable_Profiling = null, g.unstable_UserBlockingPriority = 2, g.unstable_cancelCallback = function(p) {
      p.callback = null;
    }, g.unstable_forceFrameRate = function(p) {
      0 > p || 125 < p ? console.error(
        "forceFrameRate takes a positive int between 0 and 125, forcing frame rates higher than 125 fps is not supported"
      ) : qt = 0 < p ? Math.floor(1e3 / p) : 5;
    }, g.unstable_getCurrentPriorityLevel = function() {
      return Z;
    }, g.unstable_next = function(p) {
      switch (Z) {
        case 1:
        case 2:
        case 3:
          var U = 3;
          break;
        default:
          U = Z;
      }
      var x = Z;
      Z = U;
      try {
        return p();
      } finally {
        Z = x;
      }
    }, g.unstable_requestPaint = function() {
      Mt = !0;
    }, g.unstable_runWithPriority = function(p, U) {
      switch (p) {
        case 1:
        case 2:
        case 3:
        case 4:
        case 5:
          break;
        default:
          p = 3;
      }
      var x = Z;
      Z = p;
      try {
        return U();
      } finally {
        Z = x;
      }
    }, g.unstable_scheduleCallback = function(p, U, x) {
      var et = g.unstable_now();
      switch (typeof x == "object" && x !== null ? (x = x.delay, x = typeof x == "number" && 0 < x ? et + x : et) : x = et, p) {
        case 1:
          var ft = -1;
          break;
        case 2:
          ft = 250;
          break;
        case 5:
          ft = 1073741823;
          break;
        case 4:
          ft = 1e4;
          break;
        default:
          ft = 5e3;
      }
      return ft = x + ft, p = {
        id: j++,
        callback: U,
        priorityLevel: p,
        startTime: x,
        expirationTime: ft,
        sortIndex: -1
      }, x > et ? (p.sortIndex = x, R(E, p), N(z) === null && p === N(E) && (F ? (Ht(tt), tt = -1) : F = !0, me(St, x - et))) : (p.sortIndex = ft, R(z, p), rt || ut || (rt = !0, pt || (pt = !0, ne()))), p;
    }, g.unstable_shouldYield = Ge, g.unstable_wrapCallback = function(p) {
      var U = Z;
      return function() {
        var x = Z;
        Z = U;
        try {
          return p.apply(this, arguments);
        } finally {
          Z = x;
        }
      };
    };
  }(Pf)), Pf;
}
var Yd;
function rh() {
  return Yd || (Yd = 1, Ff.exports = oh()), Ff.exports;
}
var ts = { exports: {} }, nt = {};
/**
 * @license React
 * react.production.js
 *
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
var wd;
function dh() {
  if (wd) return nt;
  wd = 1;
  var g = Symbol.for("react.transitional.element"), R = Symbol.for("react.portal"), N = Symbol.for("react.fragment"), r = Symbol.for("react.strict_mode"), J = Symbol.for("react.profiler"), at = Symbol.for("react.consumer"), I = Symbol.for("react.context"), V = Symbol.for("react.forward_ref"), z = Symbol.for("react.suspense"), E = Symbol.for("react.memo"), j = Symbol.for("react.lazy"), H = Symbol.for("react.activity"), Z = Symbol.iterator;
  function ut(o) {
    return o === null || typeof o != "object" ? null : (o = Z && o[Z] || o["@@iterator"], typeof o == "function" ? o : null);
  }
  var rt = {
    isMounted: function() {
      return !1;
    },
    enqueueForceUpdate: function() {
    },
    enqueueReplaceState: function() {
    },
    enqueueSetState: function() {
    }
  }, F = Object.assign, Mt = {};
  function ht(o, _, C) {
    this.props = o, this.context = _, this.refs = Mt, this.updater = C || rt;
  }
  ht.prototype.isReactComponent = {}, ht.prototype.setState = function(o, _) {
    if (typeof o != "object" && typeof o != "function" && o != null)
      throw Error(
        "takes an object of state variables to update or a function which returns an object of state variables."
      );
    this.updater.enqueueSetState(this, o, _, "setState");
  }, ht.prototype.forceUpdate = function(o) {
    this.updater.enqueueForceUpdate(this, o, "forceUpdate");
  };
  function Ht() {
  }
  Ht.prototype = ht.prototype;
  function Nt(o, _, C) {
    this.props = o, this.context = _, this.refs = Mt, this.updater = C || rt;
  }
  var jt = Nt.prototype = new Ht();
  jt.constructor = Nt, F(jt, ht.prototype), jt.isPureReactComponent = !0;
  var St = Array.isArray;
  function pt() {
  }
  var tt = { H: null, A: null, T: null, S: null }, qt = Object.prototype.hasOwnProperty;
  function Qt(o, _, C) {
    var q = C.ref;
    return {
      $$typeof: g,
      type: o,
      key: _,
      ref: q !== void 0 ? q : null,
      props: C
    };
  }
  function Ge(o, _) {
    return Qt(o.type, _, o.props);
  }
  function ge(o) {
    return typeof o == "object" && o !== null && o.$$typeof === g;
  }
  function ne(o) {
    var _ = { "=": "=0", ":": "=2" };
    return "$" + o.replace(/[=:]/g, function(C) {
      return _[C];
    });
  }
  var qe = /\/+/g;
  function oe(o, _) {
    return typeof o == "object" && o !== null && o.key != null ? ne("" + o.key) : _.toString(36);
  }
  function me(o) {
    switch (o.status) {
      case "fulfilled":
        return o.value;
      case "rejected":
        throw o.reason;
      default:
        switch (typeof o.status == "string" ? o.then(pt, pt) : (o.status = "pending", o.then(
          function(_) {
            o.status === "pending" && (o.status = "fulfilled", o.value = _);
          },
          function(_) {
            o.status === "pending" && (o.status = "rejected", o.reason = _);
          }
        )), o.status) {
          case "fulfilled":
            return o.value;
          case "rejected":
            throw o.reason;
        }
    }
    throw o;
  }
  function p(o, _, C, q, lt) {
    var ot = typeof o;
    (ot === "undefined" || ot === "boolean") && (o = null);
    var _t = !1;
    if (o === null) _t = !0;
    else
      switch (ot) {
        case "bigint":
        case "string":
        case "number":
          _t = !0;
          break;
        case "object":
          switch (o.$$typeof) {
            case g:
            case R:
              _t = !0;
              break;
            case j:
              return _t = o._init, p(
                _t(o._payload),
                _,
                C,
                q,
                lt
              );
          }
      }
    if (_t)
      return lt = lt(o), _t = q === "" ? "." + oe(o, 0) : q, St(lt) ? (C = "", _t != null && (C = _t.replace(qe, "$&/") + "/"), p(lt, _, C, "", function(il) {
        return il;
      })) : lt != null && (ge(lt) && (lt = Ge(
        lt,
        C + (lt.key == null || o && o.key === lt.key ? "" : ("" + lt.key).replace(
          qe,
          "$&/"
        ) + "/") + _t
      )), _.push(lt)), 1;
    _t = 0;
    var he = q === "" ? "." : q + ":";
    if (St(o))
      for (var Jt = 0; Jt < o.length; Jt++)
        q = o[Jt], ot = he + oe(q, Jt), _t += p(
          q,
          _,
          C,
          ot,
          lt
        );
    else if (Jt = ut(o), typeof Jt == "function")
      for (o = Jt.call(o), Jt = 0; !(q = o.next()).done; )
        q = q.value, ot = he + oe(q, Jt++), _t += p(
          q,
          _,
          C,
          ot,
          lt
        );
    else if (ot === "object") {
      if (typeof o.then == "function")
        return p(
          me(o),
          _,
          C,
          q,
          lt
        );
      throw _ = String(o), Error(
        "Objects are not valid as a React child (found: " + (_ === "[object Object]" ? "object with keys {" + Object.keys(o).join(", ") + "}" : _) + "). If you meant to render a collection of children, use an array instead."
      );
    }
    return _t;
  }
  function U(o, _, C) {
    if (o == null) return o;
    var q = [], lt = 0;
    return p(o, q, "", "", function(ot) {
      return _.call(C, ot, lt++);
    }), q;
  }
  function x(o) {
    if (o._status === -1) {
      var _ = o._result;
      _ = _(), _.then(
        function(C) {
          (o._status === 0 || o._status === -1) && (o._status = 1, o._result = C);
        },
        function(C) {
          (o._status === 0 || o._status === -1) && (o._status = 2, o._result = C);
        }
      ), o._status === -1 && (o._status = 0, o._result = _);
    }
    if (o._status === 1) return o._result.default;
    throw o._result;
  }
  var et = typeof reportError == "function" ? reportError : function(o) {
    if (typeof window == "object" && typeof window.ErrorEvent == "function") {
      var _ = new window.ErrorEvent("error", {
        bubbles: !0,
        cancelable: !0,
        message: typeof o == "object" && o !== null && typeof o.message == "string" ? String(o.message) : String(o),
        error: o
      });
      if (!window.dispatchEvent(_)) return;
    } else if (typeof process == "object" && typeof process.emit == "function") {
      process.emit("uncaughtException", o);
      return;
    }
    console.error(o);
  }, ft = {
    map: U,
    forEach: function(o, _, C) {
      U(
        o,
        function() {
          _.apply(this, arguments);
        },
        C
      );
    },
    count: function(o) {
      var _ = 0;
      return U(o, function() {
        _++;
      }), _;
    },
    toArray: function(o) {
      return U(o, function(_) {
        return _;
      }) || [];
    },
    only: function(o) {
      if (!ge(o))
        throw Error(
          "React.Children.only expected to receive a single React element child."
        );
      return o;
    }
  };
  return nt.Activity = H, nt.Children = ft, nt.Component = ht, nt.Fragment = N, nt.Profiler = J, nt.PureComponent = Nt, nt.StrictMode = r, nt.Suspense = z, nt.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE = tt, nt.__COMPILER_RUNTIME = {
    __proto__: null,
    c: function(o) {
      return tt.H.useMemoCache(o);
    }
  }, nt.cache = function(o) {
    return function() {
      return o.apply(null, arguments);
    };
  }, nt.cacheSignal = function() {
    return null;
  }, nt.cloneElement = function(o, _, C) {
    if (o == null)
      throw Error(
        "The argument must be a React element, but you passed " + o + "."
      );
    var q = F({}, o.props), lt = o.key;
    if (_ != null)
      for (ot in _.key !== void 0 && (lt = "" + _.key), _)
        !qt.call(_, ot) || ot === "key" || ot === "__self" || ot === "__source" || ot === "ref" && _.ref === void 0 || (q[ot] = _[ot]);
    var ot = arguments.length - 2;
    if (ot === 1) q.children = C;
    else if (1 < ot) {
      for (var _t = Array(ot), he = 0; he < ot; he++)
        _t[he] = arguments[he + 2];
      q.children = _t;
    }
    return Qt(o.type, lt, q);
  }, nt.createContext = function(o) {
    return o = {
      $$typeof: I,
      _currentValue: o,
      _currentValue2: o,
      _threadCount: 0,
      Provider: null,
      Consumer: null
    }, o.Provider = o, o.Consumer = {
      $$typeof: at,
      _context: o
    }, o;
  }, nt.createElement = function(o, _, C) {
    var q, lt = {}, ot = null;
    if (_ != null)
      for (q in _.key !== void 0 && (ot = "" + _.key), _)
        qt.call(_, q) && q !== "key" && q !== "__self" && q !== "__source" && (lt[q] = _[q]);
    var _t = arguments.length - 2;
    if (_t === 1) lt.children = C;
    else if (1 < _t) {
      for (var he = Array(_t), Jt = 0; Jt < _t; Jt++)
        he[Jt] = arguments[Jt + 2];
      lt.children = he;
    }
    if (o && o.defaultProps)
      for (q in _t = o.defaultProps, _t)
        lt[q] === void 0 && (lt[q] = _t[q]);
    return Qt(o, ot, lt);
  }, nt.createRef = function() {
    return { current: null };
  }, nt.forwardRef = function(o) {
    return { $$typeof: V, render: o };
  }, nt.isValidElement = ge, nt.lazy = function(o) {
    return {
      $$typeof: j,
      _payload: { _status: -1, _result: o },
      _init: x
    };
  }, nt.memo = function(o, _) {
    return {
      $$typeof: E,
      type: o,
      compare: _ === void 0 ? null : _
    };
  }, nt.startTransition = function(o) {
    var _ = tt.T, C = {};
    tt.T = C;
    try {
      var q = o(), lt = tt.S;
      lt !== null && lt(C, q), typeof q == "object" && q !== null && typeof q.then == "function" && q.then(pt, et);
    } catch (ot) {
      et(ot);
    } finally {
      _ !== null && C.types !== null && (_.types = C.types), tt.T = _;
    }
  }, nt.unstable_useCacheRefresh = function() {
    return tt.H.useCacheRefresh();
  }, nt.use = function(o) {
    return tt.H.use(o);
  }, nt.useActionState = function(o, _, C) {
    return tt.H.useActionState(o, _, C);
  }, nt.useCallback = function(o, _) {
    return tt.H.useCallback(o, _);
  }, nt.useContext = function(o) {
    return tt.H.useContext(o);
  }, nt.useDebugValue = function() {
  }, nt.useDeferredValue = function(o, _) {
    return tt.H.useDeferredValue(o, _);
  }, nt.useEffect = function(o, _) {
    return tt.H.useEffect(o, _);
  }, nt.useEffectEvent = function(o) {
    return tt.H.useEffectEvent(o);
  }, nt.useId = function() {
    return tt.H.useId();
  }, nt.useImperativeHandle = function(o, _, C) {
    return tt.H.useImperativeHandle(o, _, C);
  }, nt.useInsertionEffect = function(o, _) {
    return tt.H.useInsertionEffect(o, _);
  }, nt.useLayoutEffect = function(o, _) {
    return tt.H.useLayoutEffect(o, _);
  }, nt.useMemo = function(o, _) {
    return tt.H.useMemo(o, _);
  }, nt.useOptimistic = function(o, _) {
    return tt.H.useOptimistic(o, _);
  }, nt.useReducer = function(o, _, C) {
    return tt.H.useReducer(o, _, C);
  }, nt.useRef = function(o) {
    return tt.H.useRef(o);
  }, nt.useState = function(o) {
    return tt.H.useState(o);
  }, nt.useSyncExternalStore = function(o, _, C) {
    return tt.H.useSyncExternalStore(
      o,
      _,
      C
    );
  }, nt.useTransition = function() {
    return tt.H.useTransition();
  }, nt.version = "19.2.7", nt;
}
var Xd;
function as() {
  return Xd || (Xd = 1, ts.exports = dh()), ts.exports;
}
var es = { exports: {} }, Ae = {};
/**
 * @license React
 * react-dom.production.js
 *
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
var Zd;
function gh() {
  if (Zd) return Ae;
  Zd = 1;
  var g = as();
  function R(z) {
    var E = "https://react.dev/errors/" + z;
    if (1 < arguments.length) {
      E += "?args[]=" + encodeURIComponent(arguments[1]);
      for (var j = 2; j < arguments.length; j++)
        E += "&args[]=" + encodeURIComponent(arguments[j]);
    }
    return "Minified React error #" + z + "; visit " + E + " for the full message or use the non-minified dev environment for full errors and additional helpful warnings.";
  }
  function N() {
  }
  var r = {
    d: {
      f: N,
      r: function() {
        throw Error(R(522));
      },
      D: N,
      C: N,
      L: N,
      m: N,
      X: N,
      S: N,
      M: N
    },
    p: 0,
    findDOMNode: null
  }, J = Symbol.for("react.portal");
  function at(z, E, j) {
    var H = 3 < arguments.length && arguments[3] !== void 0 ? arguments[3] : null;
    return {
      $$typeof: J,
      key: H == null ? null : "" + H,
      children: z,
      containerInfo: E,
      implementation: j
    };
  }
  var I = g.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  function V(z, E) {
    if (z === "font") return "";
    if (typeof E == "string")
      return E === "use-credentials" ? E : "";
  }
  return Ae.__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE = r, Ae.createPortal = function(z, E) {
    var j = 2 < arguments.length && arguments[2] !== void 0 ? arguments[2] : null;
    if (!E || E.nodeType !== 1 && E.nodeType !== 9 && E.nodeType !== 11)
      throw Error(R(299));
    return at(z, E, null, j);
  }, Ae.flushSync = function(z) {
    var E = I.T, j = r.p;
    try {
      if (I.T = null, r.p = 2, z) return z();
    } finally {
      I.T = E, r.p = j, r.d.f();
    }
  }, Ae.preconnect = function(z, E) {
    typeof z == "string" && (E ? (E = E.crossOrigin, E = typeof E == "string" ? E === "use-credentials" ? E : "" : void 0) : E = null, r.d.C(z, E));
  }, Ae.prefetchDNS = function(z) {
    typeof z == "string" && r.d.D(z);
  }, Ae.preinit = function(z, E) {
    if (typeof z == "string" && E && typeof E.as == "string") {
      var j = E.as, H = V(j, E.crossOrigin), Z = typeof E.integrity == "string" ? E.integrity : void 0, ut = typeof E.fetchPriority == "string" ? E.fetchPriority : void 0;
      j === "style" ? r.d.S(
        z,
        typeof E.precedence == "string" ? E.precedence : void 0,
        {
          crossOrigin: H,
          integrity: Z,
          fetchPriority: ut
        }
      ) : j === "script" && r.d.X(z, {
        crossOrigin: H,
        integrity: Z,
        fetchPriority: ut,
        nonce: typeof E.nonce == "string" ? E.nonce : void 0
      });
    }
  }, Ae.preinitModule = function(z, E) {
    if (typeof z == "string")
      if (typeof E == "object" && E !== null) {
        if (E.as == null || E.as === "script") {
          var j = V(
            E.as,
            E.crossOrigin
          );
          r.d.M(z, {
            crossOrigin: j,
            integrity: typeof E.integrity == "string" ? E.integrity : void 0,
            nonce: typeof E.nonce == "string" ? E.nonce : void 0
          });
        }
      } else E == null && r.d.M(z);
  }, Ae.preload = function(z, E) {
    if (typeof z == "string" && typeof E == "object" && E !== null && typeof E.as == "string") {
      var j = E.as, H = V(j, E.crossOrigin);
      r.d.L(z, j, {
        crossOrigin: H,
        integrity: typeof E.integrity == "string" ? E.integrity : void 0,
        nonce: typeof E.nonce == "string" ? E.nonce : void 0,
        type: typeof E.type == "string" ? E.type : void 0,
        fetchPriority: typeof E.fetchPriority == "string" ? E.fetchPriority : void 0,
        referrerPolicy: typeof E.referrerPolicy == "string" ? E.referrerPolicy : void 0,
        imageSrcSet: typeof E.imageSrcSet == "string" ? E.imageSrcSet : void 0,
        imageSizes: typeof E.imageSizes == "string" ? E.imageSizes : void 0,
        media: typeof E.media == "string" ? E.media : void 0
      });
    }
  }, Ae.preloadModule = function(z, E) {
    if (typeof z == "string")
      if (E) {
        var j = V(E.as, E.crossOrigin);
        r.d.m(z, {
          as: typeof E.as == "string" && E.as !== "script" ? E.as : void 0,
          crossOrigin: j,
          integrity: typeof E.integrity == "string" ? E.integrity : void 0
        });
      } else r.d.m(z);
  }, Ae.requestFormReset = function(z) {
    r.d.r(z);
  }, Ae.unstable_batchedUpdates = function(z, E) {
    return z(E);
  }, Ae.useFormState = function(z, E, j) {
    return I.H.useFormState(z, E, j);
  }, Ae.useFormStatus = function() {
    return I.H.useHostTransitionStatus();
  }, Ae.version = "19.2.7", Ae;
}
var jd;
function mh() {
  if (jd) return es.exports;
  jd = 1;
  function g() {
    if (!(typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ > "u" || typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE != "function"))
      try {
        __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE(g);
      } catch (R) {
        console.error(R);
      }
  }
  return g(), es.exports = gh(), es.exports;
}
/**
 * @license React
 * react-dom-client.production.js
 *
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
var Qd;
function hh() {
  if (Qd) return Eu;
  Qd = 1;
  var g = rh(), R = as(), N = mh();
  function r(t) {
    var e = "https://react.dev/errors/" + t;
    if (1 < arguments.length) {
      e += "?args[]=" + encodeURIComponent(arguments[1]);
      for (var l = 2; l < arguments.length; l++)
        e += "&args[]=" + encodeURIComponent(arguments[l]);
    }
    return "Minified React error #" + t + "; visit " + e + " for the full message or use the non-minified dev environment for full errors and additional helpful warnings.";
  }
  function J(t) {
    return !(!t || t.nodeType !== 1 && t.nodeType !== 9 && t.nodeType !== 11);
  }
  function at(t) {
    var e = t, l = t;
    if (t.alternate) for (; e.return; ) e = e.return;
    else {
      t = e;
      do
        e = t, e.flags & 4098 && (l = e.return), t = e.return;
      while (t);
    }
    return e.tag === 3 ? l : null;
  }
  function I(t) {
    if (t.tag === 13) {
      var e = t.memoizedState;
      if (e === null && (t = t.alternate, t !== null && (e = t.memoizedState)), e !== null) return e.dehydrated;
    }
    return null;
  }
  function V(t) {
    if (t.tag === 31) {
      var e = t.memoizedState;
      if (e === null && (t = t.alternate, t !== null && (e = t.memoizedState)), e !== null) return e.dehydrated;
    }
    return null;
  }
  function z(t) {
    if (at(t) !== t)
      throw Error(r(188));
  }
  function E(t) {
    var e = t.alternate;
    if (!e) {
      if (e = at(t), e === null) throw Error(r(188));
      return e !== t ? null : t;
    }
    for (var l = t, n = e; ; ) {
      var a = l.return;
      if (a === null) break;
      var u = a.alternate;
      if (u === null) {
        if (n = a.return, n !== null) {
          l = n;
          continue;
        }
        break;
      }
      if (a.child === u.child) {
        for (u = a.child; u; ) {
          if (u === l) return z(a), t;
          if (u === n) return z(a), e;
          u = u.sibling;
        }
        throw Error(r(188));
      }
      if (l.return !== n.return) l = a, n = u;
      else {
        for (var i = !1, c = a.child; c; ) {
          if (c === l) {
            i = !0, l = a, n = u;
            break;
          }
          if (c === n) {
            i = !0, n = a, l = u;
            break;
          }
          c = c.sibling;
        }
        if (!i) {
          for (c = u.child; c; ) {
            if (c === l) {
              i = !0, l = u, n = a;
              break;
            }
            if (c === n) {
              i = !0, n = u, l = a;
              break;
            }
            c = c.sibling;
          }
          if (!i) throw Error(r(189));
        }
      }
      if (l.alternate !== n) throw Error(r(190));
    }
    if (l.tag !== 3) throw Error(r(188));
    return l.stateNode.current === l ? t : e;
  }
  function j(t) {
    var e = t.tag;
    if (e === 5 || e === 26 || e === 27 || e === 6) return t;
    for (t = t.child; t !== null; ) {
      if (e = j(t), e !== null) return e;
      t = t.sibling;
    }
    return null;
  }
  var H = Object.assign, Z = Symbol.for("react.element"), ut = Symbol.for("react.transitional.element"), rt = Symbol.for("react.portal"), F = Symbol.for("react.fragment"), Mt = Symbol.for("react.strict_mode"), ht = Symbol.for("react.profiler"), Ht = Symbol.for("react.consumer"), Nt = Symbol.for("react.context"), jt = Symbol.for("react.forward_ref"), St = Symbol.for("react.suspense"), pt = Symbol.for("react.suspense_list"), tt = Symbol.for("react.memo"), qt = Symbol.for("react.lazy"), Qt = Symbol.for("react.activity"), Ge = Symbol.for("react.memo_cache_sentinel"), ge = Symbol.iterator;
  function ne(t) {
    return t === null || typeof t != "object" ? null : (t = ge && t[ge] || t["@@iterator"], typeof t == "function" ? t : null);
  }
  var qe = Symbol.for("react.client.reference");
  function oe(t) {
    if (t == null) return null;
    if (typeof t == "function")
      return t.$$typeof === qe ? null : t.displayName || t.name || null;
    if (typeof t == "string") return t;
    switch (t) {
      case F:
        return "Fragment";
      case ht:
        return "Profiler";
      case Mt:
        return "StrictMode";
      case St:
        return "Suspense";
      case pt:
        return "SuspenseList";
      case Qt:
        return "Activity";
    }
    if (typeof t == "object")
      switch (t.$$typeof) {
        case rt:
          return "Portal";
        case Nt:
          return t.displayName || "Context";
        case Ht:
          return (t._context.displayName || "Context") + ".Consumer";
        case jt:
          var e = t.render;
          return t = t.displayName, t || (t = e.displayName || e.name || "", t = t !== "" ? "ForwardRef(" + t + ")" : "ForwardRef"), t;
        case tt:
          return e = t.displayName || null, e !== null ? e : oe(t.type) || "Memo";
        case qt:
          e = t._payload, t = t._init;
          try {
            return oe(t(e));
          } catch {
          }
      }
    return null;
  }
  var me = Array.isArray, p = R.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE, U = N.__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE, x = {
    pending: !1,
    data: null,
    method: null,
    action: null
  }, et = [], ft = -1;
  function o(t) {
    return { current: t };
  }
  function _(t) {
    0 > ft || (t.current = et[ft], et[ft] = null, ft--);
  }
  function C(t, e) {
    ft++, et[ft] = t.current, t.current = e;
  }
  var q = o(null), lt = o(null), ot = o(null), _t = o(null);
  function he(t, e) {
    switch (C(ot, e), C(lt, t), C(q, null), e.nodeType) {
      case 9:
      case 11:
        t = (t = e.documentElement) && (t = t.namespaceURI) ? ud(t) : 0;
        break;
      default:
        if (t = e.tagName, e = e.namespaceURI)
          e = ud(e), t = id(e, t);
        else
          switch (t) {
            case "svg":
              t = 1;
              break;
            case "math":
              t = 2;
              break;
            default:
              t = 0;
          }
    }
    _(q), C(q, t);
  }
  function Jt() {
    _(q), _(lt), _(ot);
  }
  function il(t) {
    t.memoizedState !== null && C(_t, t);
    var e = q.current, l = id(e, t.type);
    e !== l && (C(lt, t), C(q, l));
  }
  function Bn(t) {
    lt.current === t && (_(q), _(lt)), _t.current === t && (_(_t), mu._currentValue = x);
  }
  var Ea, pu;
  function gl(t) {
    if (Ea === void 0)
      try {
        throw Error();
      } catch (l) {
        var e = l.stack.trim().match(/\n( *(at )?)/);
        Ea = e && e[1] || "", pu = -1 < l.stack.indexOf(`
    at`) ? " (<anonymous>)" : -1 < l.stack.indexOf("@") ? "@unknown:0:0" : "";
      }
    return `
` + Ea + t + pu;
  }
  var pa = !1;
  function Sa(t, e) {
    if (!t || pa) return "";
    pa = !0;
    var l = Error.prepareStackTrace;
    Error.prepareStackTrace = void 0;
    try {
      var n = {
        DetermineComponentFrameRoot: function() {
          try {
            if (e) {
              var O = function() {
                throw Error();
              };
              if (Object.defineProperty(O.prototype, "props", {
                set: function() {
                  throw Error();
                }
              }), typeof Reflect == "object" && Reflect.construct) {
                try {
                  Reflect.construct(O, []);
                } catch (v) {
                  var y = v;
                }
                Reflect.construct(t, [], O);
              } else {
                try {
                  O.call();
                } catch (v) {
                  y = v;
                }
                t.call(O.prototype);
              }
            } else {
              try {
                throw Error();
              } catch (v) {
                y = v;
              }
              (O = t()) && typeof O.catch == "function" && O.catch(function() {
              });
            }
          } catch (v) {
            if (v && y && typeof v.stack == "string")
              return [v.stack, y.stack];
          }
          return [null, null];
        }
      };
      n.DetermineComponentFrameRoot.displayName = "DetermineComponentFrameRoot";
      var a = Object.getOwnPropertyDescriptor(
        n.DetermineComponentFrameRoot,
        "name"
      );
      a && a.configurable && Object.defineProperty(
        n.DetermineComponentFrameRoot,
        "name",
        { value: "DetermineComponentFrameRoot" }
      );
      var u = n.DetermineComponentFrameRoot(), i = u[0], c = u[1];
      if (i && c) {
        var f = i.split(`
`), b = c.split(`
`);
        for (a = n = 0; n < f.length && !f[n].includes("DetermineComponentFrameRoot"); )
          n++;
        for (; a < b.length && !b[a].includes(
          "DetermineComponentFrameRoot"
        ); )
          a++;
        if (n === f.length || a === b.length)
          for (n = f.length - 1, a = b.length - 1; 1 <= n && 0 <= a && f[n] !== b[a]; )
            a--;
        for (; 1 <= n && 0 <= a; n--, a--)
          if (f[n] !== b[a]) {
            if (n !== 1 || a !== 1)
              do
                if (n--, a--, 0 > a || f[n] !== b[a]) {
                  var S = `
` + f[n].replace(" at new ", " at ");
                  return t.displayName && S.includes("<anonymous>") && (S = S.replace("<anonymous>", t.displayName)), S;
                }
              while (1 <= n && 0 <= a);
            break;
          }
      }
    } finally {
      pa = !1, Error.prepareStackTrace = l;
    }
    return (l = t ? t.displayName || t.name : "") ? gl(l) : "";
  }
  function Zi(t, e) {
    switch (t.tag) {
      case 26:
      case 27:
      case 5:
        return gl(t.type);
      case 16:
        return gl("Lazy");
      case 13:
        return t.child !== e && e !== null ? gl("Suspense Fallback") : gl("Suspense");
      case 19:
        return gl("SuspenseList");
      case 0:
      case 15:
        return Sa(t.type, !1);
      case 11:
        return Sa(t.type.render, !1);
      case 1:
        return Sa(t.type, !0);
      case 31:
        return gl("Activity");
      default:
        return "";
    }
  }
  function Su(t) {
    try {
      var e = "", l = null;
      do
        e += Zi(t, l), l = t, t = t.return;
      while (t);
      return e;
    } catch (n) {
      return `
Error generating stack: ` + n.message + `
` + n.stack;
    }
  }
  var _a = Object.prototype.hasOwnProperty, Hn = g.unstable_scheduleCallback, Ta = g.unstable_cancelCallback, ji = g.unstable_shouldYield, _u = g.unstable_requestPaint, It = g.unstable_now, Tu = g.unstable_getCurrentPriorityLevel, ml = g.unstable_ImmediatePriority, on = g.unstable_UserBlockingPriority, rn = g.unstable_NormalPriority, Qi = g.unstable_LowPriority, Au = g.unstable_IdlePriority, Ki = g.log, Vi = g.unstable_setDisableYieldValue, dn = null, Se = null;
  function cl(t) {
    if (typeof Ki == "function" && Vi(t), Se && typeof Se.setStrictMode == "function")
      try {
        Se.setStrictMode(dn, t);
      } catch {
      }
  }
  var Oe = Math.clz32 ? Math.clz32 : Ou, ki = Math.log, Aa = Math.LN2;
  function Ou(t) {
    return t >>>= 0, t === 0 ? 32 : 31 - (ki(t) / Aa | 0) | 0;
  }
  var gn = 256, Ln = 262144, mn = 4194304;
  function Re(t) {
    var e = t & 42;
    if (e !== 0) return e;
    switch (t & -t) {
      case 1:
        return 1;
      case 2:
        return 2;
      case 4:
        return 4;
      case 8:
        return 8;
      case 16:
        return 16;
      case 32:
        return 32;
      case 64:
        return 64;
      case 128:
        return 128;
      case 256:
      case 512:
      case 1024:
      case 2048:
      case 4096:
      case 8192:
      case 16384:
      case 32768:
      case 65536:
      case 131072:
        return t & 261888;
      case 262144:
      case 524288:
      case 1048576:
      case 2097152:
        return t & 3932160;
      case 4194304:
      case 8388608:
      case 16777216:
      case 33554432:
        return t & 62914560;
      case 67108864:
        return 67108864;
      case 134217728:
        return 134217728;
      case 268435456:
        return 268435456;
      case 536870912:
        return 536870912;
      case 1073741824:
        return 0;
      default:
        return t;
    }
  }
  function s(t, e, l) {
    var n = t.pendingLanes;
    if (n === 0) return 0;
    var a = 0, u = t.suspendedLanes, i = t.pingedLanes;
    t = t.warmLanes;
    var c = n & 134217727;
    return c !== 0 ? (n = c & ~u, n !== 0 ? a = Re(n) : (i &= c, i !== 0 ? a = Re(i) : l || (l = c & ~t, l !== 0 && (a = Re(l))))) : (c = n & ~u, c !== 0 ? a = Re(c) : i !== 0 ? a = Re(i) : l || (l = n & ~t, l !== 0 && (a = Re(l)))), a === 0 ? 0 : e !== 0 && e !== a && !(e & u) && (u = a & -a, l = e & -e, u >= l || u === 32 && (l & 4194048) !== 0) ? e : a;
  }
  function T(t, e) {
    return (t.pendingLanes & ~(t.suspendedLanes & ~t.pingedLanes) & e) === 0;
  }
  function B(t, e) {
    switch (t) {
      case 1:
      case 2:
      case 4:
      case 8:
      case 64:
        return e + 250;
      case 16:
      case 32:
      case 128:
      case 256:
      case 512:
      case 1024:
      case 2048:
      case 4096:
      case 8192:
      case 16384:
      case 32768:
      case 65536:
      case 131072:
      case 262144:
      case 524288:
      case 1048576:
      case 2097152:
        return e + 5e3;
      case 4194304:
      case 8388608:
      case 16777216:
      case 33554432:
        return -1;
      case 67108864:
      case 134217728:
      case 268435456:
      case 536870912:
      case 1073741824:
        return -1;
      default:
        return -1;
    }
  }
  function P() {
    var t = mn;
    return mn <<= 1, !(mn & 62914560) && (mn = 4194304), t;
  }
  function wt(t) {
    for (var e = [], l = 0; 31 > l; l++) e.push(t);
    return e;
  }
  function Lt(t, e) {
    t.pendingLanes |= e, e !== 268435456 && (t.suspendedLanes = 0, t.pingedLanes = 0, t.warmLanes = 0);
  }
  function Y(t, e, l, n, a, u) {
    var i = t.pendingLanes;
    t.pendingLanes = l, t.suspendedLanes = 0, t.pingedLanes = 0, t.warmLanes = 0, t.expiredLanes &= l, t.entangledLanes &= l, t.errorRecoveryDisabledLanes &= l, t.shellSuspendCounter = 0;
    var c = t.entanglements, f = t.expirationTimes, b = t.hiddenUpdates;
    for (l = i & ~l; 0 < l; ) {
      var S = 31 - Oe(l), O = 1 << S;
      c[S] = 0, f[S] = -1;
      var y = b[S];
      if (y !== null)
        for (b[S] = null, S = 0; S < y.length; S++) {
          var v = y[S];
          v !== null && (v.lane &= -536870913);
        }
      l &= ~O;
    }
    n !== 0 && L(t, n, 0), u !== 0 && a === 0 && t.tag !== 0 && (t.suspendedLanes |= u & ~(i & ~e));
  }
  function L(t, e, l) {
    t.pendingLanes |= e, t.suspendedLanes &= ~e;
    var n = 31 - Oe(e);
    t.entangledLanes |= e, t.entanglements[n] = t.entanglements[n] | 1073741824 | l & 261930;
  }
  function W(t, e) {
    var l = t.entangledLanes |= e;
    for (t = t.entanglements; l; ) {
      var n = 31 - Oe(l), a = 1 << n;
      a & e | t[n] & e && (t[n] |= e), l &= ~a;
    }
  }
  function Ft(t, e) {
    var l = e & -e;
    return l = l & 42 ? 1 : Kt(l), l & (t.suspendedLanes | e) ? 0 : l;
  }
  function Kt(t) {
    switch (t) {
      case 2:
        t = 1;
        break;
      case 8:
        t = 4;
        break;
      case 32:
        t = 16;
        break;
      case 256:
      case 512:
      case 1024:
      case 2048:
      case 4096:
      case 8192:
      case 16384:
      case 32768:
      case 65536:
      case 131072:
      case 262144:
      case 524288:
      case 1048576:
      case 2097152:
      case 4194304:
      case 8388608:
      case 16777216:
      case 33554432:
        t = 128;
        break;
      case 268435456:
        t = 134217728;
        break;
      default:
        t = 0;
    }
    return t;
  }
  function hl(t) {
    return t &= -t, 2 < t ? 8 < t ? t & 134217727 ? 32 : 268435456 : 8 : 2;
  }
  function Gn() {
    var t = U.p;
    return t !== 0 ? t : (t = window.event, t === void 0 ? 32 : zd(t.type));
  }
  function qn(t, e) {
    var l = U.p;
    try {
      return U.p = t, e();
    } finally {
      U.p = l;
    }
  }
  var fl = Math.random().toString(36).slice(2), Pt = "__reactFiber$" + fl, _e = "__reactProps$" + fl, Hl = "__reactContainer$" + fl, Oa = "__reactEvents$" + fl, Nu = "__reactListeners$" + fl, Yn = "__reactHandles$" + fl, Mu = "__reactResources$" + fl, hn = "__reactMarker$" + fl;
  function Na(t) {
    delete t[Pt], delete t[_e], delete t[Oa], delete t[Nu], delete t[Yn];
  }
  function Ne(t) {
    var e = t[Pt];
    if (e) return e;
    for (var l = t.parentNode; l; ) {
      if (e = l[Hl] || l[Pt]) {
        if (l = e.alternate, e.child !== null || l !== null && l.child !== null)
          for (t = gd(t); t !== null; ) {
            if (l = t[Pt]) return l;
            t = gd(t);
          }
        return e;
      }
      t = l, l = t.parentNode;
    }
    return null;
  }
  function bl(t) {
    if (t = t[Pt] || t[Hl]) {
      var e = t.tag;
      if (e === 5 || e === 6 || e === 13 || e === 31 || e === 26 || e === 27 || e === 3)
        return t;
    }
    return null;
  }
  function Ll(t) {
    var e = t.tag;
    if (e === 5 || e === 26 || e === 27 || e === 6) return t.stateNode;
    throw Error(r(33));
  }
  function Gl(t) {
    var e = t[Mu];
    return e || (e = t[Mu] = { hoistableStyles: /* @__PURE__ */ new Map(), hoistableScripts: /* @__PURE__ */ new Map() }), e;
  }
  function ae(t) {
    t[hn] = !0;
  }
  var Ru = /* @__PURE__ */ new Set(), bn = {};
  function yl(t, e) {
    M(t, e), M(t + "Capture", e);
  }
  function M(t, e) {
    for (bn[t] = e, t = 0; t < e.length; t++)
      Ru.add(e[t]);
  }
  var Q = RegExp(
    "^[:A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD][:A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040]*$"
  ), dt = {}, Rt = {};
  function te(t) {
    return _a.call(Rt, t) ? !0 : _a.call(dt, t) ? !1 : Q.test(t) ? Rt[t] = !0 : (dt[t] = !0, !1);
  }
  function Te(t, e, l) {
    if (te(e))
      if (l === null) t.removeAttribute(e);
      else {
        switch (typeof l) {
          case "undefined":
          case "function":
          case "symbol":
            t.removeAttribute(e);
            return;
          case "boolean":
            var n = e.toLowerCase().slice(0, 5);
            if (n !== "data-" && n !== "aria-") {
              t.removeAttribute(e);
              return;
            }
        }
        t.setAttribute(e, "" + l);
      }
  }
  function Ye(t, e, l) {
    if (l === null) t.removeAttribute(e);
    else {
      switch (typeof l) {
        case "undefined":
        case "function":
        case "symbol":
        case "boolean":
          t.removeAttribute(e);
          return;
      }
      t.setAttribute(e, "" + l);
    }
  }
  function ze(t, e, l, n) {
    if (n === null) t.removeAttribute(l);
    else {
      switch (typeof n) {
        case "undefined":
        case "function":
        case "symbol":
        case "boolean":
          t.removeAttribute(l);
          return;
      }
      t.setAttributeNS(e, l, "" + n);
    }
  }
  function Yt(t) {
    switch (typeof t) {
      case "bigint":
      case "boolean":
      case "number":
      case "string":
      case "undefined":
        return t;
      case "object":
        return t;
      default:
        return "";
    }
  }
  function we(t) {
    var e = t.type;
    return (t = t.nodeName) && t.toLowerCase() === "input" && (e === "checkbox" || e === "radio");
  }
  function zu(t, e, l) {
    var n = Object.getOwnPropertyDescriptor(
      t.constructor.prototype,
      e
    );
    if (!t.hasOwnProperty(e) && typeof n < "u" && typeof n.get == "function" && typeof n.set == "function") {
      var a = n.get, u = n.set;
      return Object.defineProperty(t, e, {
        configurable: !0,
        get: function() {
          return a.call(this);
        },
        set: function(i) {
          l = "" + i, u.call(this, i);
        }
      }), Object.defineProperty(t, e, {
        enumerable: n.enumerable
      }), {
        getValue: function() {
          return l;
        },
        setValue: function(i) {
          l = "" + i;
        },
        stopTracking: function() {
          t._valueTracker = null, delete t[e];
        }
      };
    }
  }
  function wn(t) {
    if (!t._valueTracker) {
      var e = we(t) ? "checked" : "value";
      t._valueTracker = zu(
        t,
        e,
        "" + t[e]
      );
    }
  }
  function Ma(t) {
    if (!t) return !1;
    var e = t._valueTracker;
    if (!e) return !0;
    var l = e.getValue(), n = "";
    return t && (n = we(t) ? t.checked ? "true" : "false" : t.value), t = n, t !== l ? (e.setValue(t), !0) : !1;
  }
  function Xn(t) {
    if (t = t || (typeof document < "u" ? document : void 0), typeof t > "u") return null;
    try {
      return t.activeElement || t.body;
    } catch {
      return t.body;
    }
  }
  var Ji = /[\n"\\]/g;
  function De(t) {
    return t.replace(
      Ji,
      function(e) {
        return "\\" + e.charCodeAt(0).toString(16) + " ";
      }
    );
  }
  function Ra(t, e, l, n, a, u, i, c) {
    t.name = "", i != null && typeof i != "function" && typeof i != "symbol" && typeof i != "boolean" ? t.type = i : t.removeAttribute("type"), e != null ? i === "number" ? (e === 0 && t.value === "" || t.value != e) && (t.value = "" + Yt(e)) : t.value !== "" + Yt(e) && (t.value = "" + Yt(e)) : i !== "submit" && i !== "reset" || t.removeAttribute("value"), e != null ? Zn(t, i, Yt(e)) : l != null ? Zn(t, i, Yt(l)) : n != null && t.removeAttribute("value"), a == null && u != null && (t.defaultChecked = !!u), a != null && (t.checked = a && typeof a != "function" && typeof a != "symbol"), c != null && typeof c != "function" && typeof c != "symbol" && typeof c != "boolean" ? t.name = "" + Yt(c) : t.removeAttribute("name");
  }
  function yn(t, e, l, n, a, u, i, c) {
    if (u != null && typeof u != "function" && typeof u != "symbol" && typeof u != "boolean" && (t.type = u), e != null || l != null) {
      if (!(u !== "submit" && u !== "reset" || e != null)) {
        wn(t);
        return;
      }
      l = l != null ? "" + Yt(l) : "", e = e != null ? "" + Yt(e) : l, c || e === t.value || (t.value = e), t.defaultValue = e;
    }
    n = n ?? a, n = typeof n != "function" && typeof n != "symbol" && !!n, t.checked = c ? t.checked : !!n, t.defaultChecked = !!n, i != null && typeof i != "function" && typeof i != "symbol" && typeof i != "boolean" && (t.name = i), wn(t);
  }
  function Zn(t, e, l) {
    e === "number" && Xn(t.ownerDocument) === t || t.defaultValue === "" + l || (t.defaultValue = "" + l);
  }
  function be(t, e, l, n) {
    if (t = t.options, e) {
      e = {};
      for (var a = 0; a < l.length; a++)
        e["$" + l[a]] = !0;
      for (l = 0; l < t.length; l++)
        a = e.hasOwnProperty("$" + t[l].value), t[l].selected !== a && (t[l].selected = a), a && n && (t[l].defaultSelected = !0);
    } else {
      for (l = "" + Yt(l), e = null, a = 0; a < t.length; a++) {
        if (t[a].value === l) {
          t[a].selected = !0, n && (t[a].defaultSelected = !0);
          return;
        }
        e !== null || t[a].disabled || (e = t[a]);
      }
      e !== null && (e.selected = !0);
    }
  }
  function Du(t, e, l) {
    if (e != null && (e = "" + Yt(e), e !== t.value && (t.value = e), l == null)) {
      t.defaultValue !== e && (t.defaultValue = e);
      return;
    }
    t.defaultValue = l != null ? "" + Yt(l) : "";
  }
  function jn(t, e, l, n) {
    if (e == null) {
      if (n != null) {
        if (l != null) throw Error(r(92));
        if (me(n)) {
          if (1 < n.length) throw Error(r(93));
          n = n[0];
        }
        l = n;
      }
      l == null && (l = ""), e = l;
    }
    l = Yt(e), t.defaultValue = l, n = t.textContent, n === l && n !== "" && n !== null && (t.value = n), wn(t);
  }
  function $(t, e) {
    if (e) {
      var l = t.firstChild;
      if (l && l === t.lastChild && l.nodeType === 3) {
        l.nodeValue = e;
        return;
      }
    }
    t.textContent = e;
  }
  var Cu = new Set(
    "animationIterationCount aspectRatio borderImageOutset borderImageSlice borderImageWidth boxFlex boxFlexGroup boxOrdinalGroup columnCount columns flex flexGrow flexPositive flexShrink flexNegative flexOrder gridArea gridRow gridRowEnd gridRowSpan gridRowStart gridColumn gridColumnEnd gridColumnSpan gridColumnStart fontWeight lineClamp lineHeight opacity order orphans scale tabSize widows zIndex zoom fillOpacity floodOpacity stopOpacity strokeDasharray strokeDashoffset strokeMiterlimit strokeOpacity strokeWidth MozAnimationIterationCount MozBoxFlex MozBoxFlexGroup MozLineClamp msAnimationIterationCount msFlex msZoom msFlexGrow msFlexNegative msFlexOrder msFlexPositive msFlexShrink msGridColumn msGridColumnSpan msGridRow msGridRowSpan WebkitAnimationIterationCount WebkitBoxFlex WebKitBoxFlexGroup WebkitBoxOrdinalGroup WebkitColumnCount WebkitColumns WebkitFlex WebkitFlexGrow WebkitFlexPositive WebkitFlexShrink WebkitLineClamp".split(
      " "
    )
  );
  function ue(t, e, l) {
    var n = e.indexOf("--") === 0;
    l == null || typeof l == "boolean" || l === "" ? n ? t.setProperty(e, "") : e === "float" ? t.cssFloat = "" : t[e] = "" : n ? t.setProperty(e, l) : typeof l != "number" || l === 0 || Cu.has(e) ? e === "float" ? t.cssFloat = l : t[e] = ("" + l).trim() : t[e] = l + "px";
  }
  function zt(t, e, l) {
    if (e != null && typeof e != "object")
      throw Error(r(62));
    if (t = t.style, l != null) {
      for (var n in l)
        !l.hasOwnProperty(n) || e != null && e.hasOwnProperty(n) || (n.indexOf("--") === 0 ? t.setProperty(n, "") : n === "float" ? t.cssFloat = "" : t[n] = "");
      for (var a in e)
        n = e[a], e.hasOwnProperty(a) && l[a] !== n && ue(t, a, n);
    } else
      for (var u in e)
        e.hasOwnProperty(u) && ue(t, u, e[u]);
  }
  function ql(t) {
    if (t.indexOf("-") === -1) return !1;
    switch (t) {
      case "annotation-xml":
      case "color-profile":
      case "font-face":
      case "font-face-src":
      case "font-face-uri":
      case "font-face-format":
      case "font-face-name":
      case "missing-glyph":
        return !1;
      default:
        return !0;
    }
  }
  var vl = /* @__PURE__ */ new Map([
    ["acceptCharset", "accept-charset"],
    ["htmlFor", "for"],
    ["httpEquiv", "http-equiv"],
    ["crossOrigin", "crossorigin"],
    ["accentHeight", "accent-height"],
    ["alignmentBaseline", "alignment-baseline"],
    ["arabicForm", "arabic-form"],
    ["baselineShift", "baseline-shift"],
    ["capHeight", "cap-height"],
    ["clipPath", "clip-path"],
    ["clipRule", "clip-rule"],
    ["colorInterpolation", "color-interpolation"],
    ["colorInterpolationFilters", "color-interpolation-filters"],
    ["colorProfile", "color-profile"],
    ["colorRendering", "color-rendering"],
    ["dominantBaseline", "dominant-baseline"],
    ["enableBackground", "enable-background"],
    ["fillOpacity", "fill-opacity"],
    ["fillRule", "fill-rule"],
    ["floodColor", "flood-color"],
    ["floodOpacity", "flood-opacity"],
    ["fontFamily", "font-family"],
    ["fontSize", "font-size"],
    ["fontSizeAdjust", "font-size-adjust"],
    ["fontStretch", "font-stretch"],
    ["fontStyle", "font-style"],
    ["fontVariant", "font-variant"],
    ["fontWeight", "font-weight"],
    ["glyphName", "glyph-name"],
    ["glyphOrientationHorizontal", "glyph-orientation-horizontal"],
    ["glyphOrientationVertical", "glyph-orientation-vertical"],
    ["horizAdvX", "horiz-adv-x"],
    ["horizOriginX", "horiz-origin-x"],
    ["imageRendering", "image-rendering"],
    ["letterSpacing", "letter-spacing"],
    ["lightingColor", "lighting-color"],
    ["markerEnd", "marker-end"],
    ["markerMid", "marker-mid"],
    ["markerStart", "marker-start"],
    ["overlinePosition", "overline-position"],
    ["overlineThickness", "overline-thickness"],
    ["paintOrder", "paint-order"],
    ["panose-1", "panose-1"],
    ["pointerEvents", "pointer-events"],
    ["renderingIntent", "rendering-intent"],
    ["shapeRendering", "shape-rendering"],
    ["stopColor", "stop-color"],
    ["stopOpacity", "stop-opacity"],
    ["strikethroughPosition", "strikethrough-position"],
    ["strikethroughThickness", "strikethrough-thickness"],
    ["strokeDasharray", "stroke-dasharray"],
    ["strokeDashoffset", "stroke-dashoffset"],
    ["strokeLinecap", "stroke-linecap"],
    ["strokeLinejoin", "stroke-linejoin"],
    ["strokeMiterlimit", "stroke-miterlimit"],
    ["strokeOpacity", "stroke-opacity"],
    ["strokeWidth", "stroke-width"],
    ["textAnchor", "text-anchor"],
    ["textDecoration", "text-decoration"],
    ["textRendering", "text-rendering"],
    ["transformOrigin", "transform-origin"],
    ["underlinePosition", "underline-position"],
    ["underlineThickness", "underline-thickness"],
    ["unicodeBidi", "unicode-bidi"],
    ["unicodeRange", "unicode-range"],
    ["unitsPerEm", "units-per-em"],
    ["vAlphabetic", "v-alphabetic"],
    ["vHanging", "v-hanging"],
    ["vIdeographic", "v-ideographic"],
    ["vMathematical", "v-mathematical"],
    ["vectorEffect", "vector-effect"],
    ["vertAdvY", "vert-adv-y"],
    ["vertOriginX", "vert-origin-x"],
    ["vertOriginY", "vert-origin-y"],
    ["wordSpacing", "word-spacing"],
    ["writingMode", "writing-mode"],
    ["xmlnsXlink", "xmlns:xlink"],
    ["xHeight", "x-height"]
  ]), za = /^[\u0000-\u001F ]*j[\r\n\t]*a[\r\n\t]*v[\r\n\t]*a[\r\n\t]*s[\r\n\t]*c[\r\n\t]*r[\r\n\t]*i[\r\n\t]*p[\r\n\t]*t[\r\n\t]*:/i;
  function Yl(t) {
    return za.test("" + t) ? "javascript:throw new Error('React has blocked a javascript: URL as a security precaution.')" : t;
  }
  function D() {
  }
  var w = null;
  function it(t) {
    return t = t.target || t.srcElement || window, t.correspondingUseElement && (t = t.correspondingUseElement), t.nodeType === 3 ? t.parentNode : t;
  }
  var bt = null, kt = null;
  function Je(t) {
    var e = bl(t);
    if (e && (t = e.stateNode)) {
      var l = t[_e] || null;
      t: switch (t = e.stateNode, e.type) {
        case "input":
          if (Ra(
            t,
            l.value,
            l.defaultValue,
            l.defaultValue,
            l.checked,
            l.defaultChecked,
            l.type,
            l.name
          ), e = l.name, l.type === "radio" && e != null) {
            for (l = t; l.parentNode; ) l = l.parentNode;
            for (l = l.querySelectorAll(
              'input[name="' + De(
                "" + e
              ) + '"][type="radio"]'
            ), e = 0; e < l.length; e++) {
              var n = l[e];
              if (n !== t && n.form === t.form) {
                var a = n[_e] || null;
                if (!a) throw Error(r(90));
                Ra(
                  n,
                  a.value,
                  a.defaultValue,
                  a.defaultValue,
                  a.checked,
                  a.defaultChecked,
                  a.type,
                  a.name
                );
              }
            }
            for (e = 0; e < l.length; e++)
              n = l[e], n.form === t.form && Ma(n);
          }
          break t;
        case "textarea":
          Du(t, l.value, l.defaultValue);
          break t;
        case "select":
          e = l.value, e != null && be(t, !!l.multiple, e, !1);
      }
    }
  }
  var Da = !1;
  function Uu(t, e, l) {
    if (Da) return t(e, l);
    Da = !0;
    try {
      var n = t(e);
      return n;
    } finally {
      if (Da = !1, (bt !== null || kt !== null) && (Ei(), bt && (e = bt, t = kt, kt = bt = null, Je(e), t)))
        for (e = 0; e < t.length; e++) Je(t[e]);
    }
  }
  function Ca(t, e) {
    var l = t.stateNode;
    if (l === null) return null;
    var n = l[_e] || null;
    if (n === null) return null;
    l = n[e];
    t: switch (e) {
      case "onClick":
      case "onClickCapture":
      case "onDoubleClick":
      case "onDoubleClickCapture":
      case "onMouseDown":
      case "onMouseDownCapture":
      case "onMouseMove":
      case "onMouseMoveCapture":
      case "onMouseUp":
      case "onMouseUpCapture":
      case "onMouseEnter":
        (n = !n.disabled) || (t = t.type, n = !(t === "button" || t === "input" || t === "select" || t === "textarea")), t = !n;
        break t;
      default:
        t = !1;
    }
    if (t) return null;
    if (l && typeof l != "function")
      throw Error(
        r(231, e, typeof l)
      );
    return l;
  }
  var El = !(typeof window > "u" || typeof window.document > "u" || typeof window.document.createElement > "u"), $i = !1;
  if (El)
    try {
      var Ua = {};
      Object.defineProperty(Ua, "passive", {
        get: function() {
          $i = !0;
        }
      }), window.addEventListener("test", Ua, Ua), window.removeEventListener("test", Ua, Ua);
    } catch {
      $i = !1;
    }
  var wl = null, Wi = null, xu = null;
  function us() {
    if (xu) return xu;
    var t, e = Wi, l = e.length, n, a = "value" in wl ? wl.value : wl.textContent, u = a.length;
    for (t = 0; t < l && e[t] === a[t]; t++) ;
    var i = l - t;
    for (n = 1; n <= i && e[l - n] === a[u - n]; n++) ;
    return xu = a.slice(t, 1 < n ? 1 - n : void 0);
  }
  function Bu(t) {
    var e = t.keyCode;
    return "charCode" in t ? (t = t.charCode, t === 0 && e === 13 && (t = 13)) : t = e, t === 10 && (t = 13), 32 <= t || t === 13 ? t : 0;
  }
  function Hu() {
    return !0;
  }
  function is() {
    return !1;
  }
  function Ce(t) {
    function e(l, n, a, u, i) {
      this._reactName = l, this._targetInst = a, this.type = n, this.nativeEvent = u, this.target = i, this.currentTarget = null;
      for (var c in t)
        t.hasOwnProperty(c) && (l = t[c], this[c] = l ? l(u) : u[c]);
      return this.isDefaultPrevented = (u.defaultPrevented != null ? u.defaultPrevented : u.returnValue === !1) ? Hu : is, this.isPropagationStopped = is, this;
    }
    return H(e.prototype, {
      preventDefault: function() {
        this.defaultPrevented = !0;
        var l = this.nativeEvent;
        l && (l.preventDefault ? l.preventDefault() : typeof l.returnValue != "unknown" && (l.returnValue = !1), this.isDefaultPrevented = Hu);
      },
      stopPropagation: function() {
        var l = this.nativeEvent;
        l && (l.stopPropagation ? l.stopPropagation() : typeof l.cancelBubble != "unknown" && (l.cancelBubble = !0), this.isPropagationStopped = Hu);
      },
      persist: function() {
      },
      isPersistent: Hu
    }), e;
  }
  var vn = {
    eventPhase: 0,
    bubbles: 0,
    cancelable: 0,
    timeStamp: function(t) {
      return t.timeStamp || Date.now();
    },
    defaultPrevented: 0,
    isTrusted: 0
  }, Lu = Ce(vn), xa = H({}, vn, { view: 0, detail: 0 }), ig = Ce(xa), Ii, Fi, Ba, Gu = H({}, xa, {
    screenX: 0,
    screenY: 0,
    clientX: 0,
    clientY: 0,
    pageX: 0,
    pageY: 0,
    ctrlKey: 0,
    shiftKey: 0,
    altKey: 0,
    metaKey: 0,
    getModifierState: tc,
    button: 0,
    buttons: 0,
    relatedTarget: function(t) {
      return t.relatedTarget === void 0 ? t.fromElement === t.srcElement ? t.toElement : t.fromElement : t.relatedTarget;
    },
    movementX: function(t) {
      return "movementX" in t ? t.movementX : (t !== Ba && (Ba && t.type === "mousemove" ? (Ii = t.screenX - Ba.screenX, Fi = t.screenY - Ba.screenY) : Fi = Ii = 0, Ba = t), Ii);
    },
    movementY: function(t) {
      return "movementY" in t ? t.movementY : Fi;
    }
  }), cs = Ce(Gu), cg = H({}, Gu, { dataTransfer: 0 }), fg = Ce(cg), sg = H({}, xa, { relatedTarget: 0 }), Pi = Ce(sg), og = H({}, vn, {
    animationName: 0,
    elapsedTime: 0,
    pseudoElement: 0
  }), rg = Ce(og), dg = H({}, vn, {
    clipboardData: function(t) {
      return "clipboardData" in t ? t.clipboardData : window.clipboardData;
    }
  }), gg = Ce(dg), mg = H({}, vn, { data: 0 }), fs = Ce(mg), hg = {
    Esc: "Escape",
    Spacebar: " ",
    Left: "ArrowLeft",
    Up: "ArrowUp",
    Right: "ArrowRight",
    Down: "ArrowDown",
    Del: "Delete",
    Win: "OS",
    Menu: "ContextMenu",
    Apps: "ContextMenu",
    Scroll: "ScrollLock",
    MozPrintableKey: "Unidentified"
  }, bg = {
    8: "Backspace",
    9: "Tab",
    12: "Clear",
    13: "Enter",
    16: "Shift",
    17: "Control",
    18: "Alt",
    19: "Pause",
    20: "CapsLock",
    27: "Escape",
    32: " ",
    33: "PageUp",
    34: "PageDown",
    35: "End",
    36: "Home",
    37: "ArrowLeft",
    38: "ArrowUp",
    39: "ArrowRight",
    40: "ArrowDown",
    45: "Insert",
    46: "Delete",
    112: "F1",
    113: "F2",
    114: "F3",
    115: "F4",
    116: "F5",
    117: "F6",
    118: "F7",
    119: "F8",
    120: "F9",
    121: "F10",
    122: "F11",
    123: "F12",
    144: "NumLock",
    145: "ScrollLock",
    224: "Meta"
  }, yg = {
    Alt: "altKey",
    Control: "ctrlKey",
    Meta: "metaKey",
    Shift: "shiftKey"
  };
  function vg(t) {
    var e = this.nativeEvent;
    return e.getModifierState ? e.getModifierState(t) : (t = yg[t]) ? !!e[t] : !1;
  }
  function tc() {
    return vg;
  }
  var Eg = H({}, xa, {
    key: function(t) {
      if (t.key) {
        var e = hg[t.key] || t.key;
        if (e !== "Unidentified") return e;
      }
      return t.type === "keypress" ? (t = Bu(t), t === 13 ? "Enter" : String.fromCharCode(t)) : t.type === "keydown" || t.type === "keyup" ? bg[t.keyCode] || "Unidentified" : "";
    },
    code: 0,
    location: 0,
    ctrlKey: 0,
    shiftKey: 0,
    altKey: 0,
    metaKey: 0,
    repeat: 0,
    locale: 0,
    getModifierState: tc,
    charCode: function(t) {
      return t.type === "keypress" ? Bu(t) : 0;
    },
    keyCode: function(t) {
      return t.type === "keydown" || t.type === "keyup" ? t.keyCode : 0;
    },
    which: function(t) {
      return t.type === "keypress" ? Bu(t) : t.type === "keydown" || t.type === "keyup" ? t.keyCode : 0;
    }
  }), pg = Ce(Eg), Sg = H({}, Gu, {
    pointerId: 0,
    width: 0,
    height: 0,
    pressure: 0,
    tangentialPressure: 0,
    tiltX: 0,
    tiltY: 0,
    twist: 0,
    pointerType: 0,
    isPrimary: 0
  }), ss = Ce(Sg), _g = H({}, xa, {
    touches: 0,
    targetTouches: 0,
    changedTouches: 0,
    altKey: 0,
    metaKey: 0,
    ctrlKey: 0,
    shiftKey: 0,
    getModifierState: tc
  }), Tg = Ce(_g), Ag = H({}, vn, {
    propertyName: 0,
    elapsedTime: 0,
    pseudoElement: 0
  }), Og = Ce(Ag), Ng = H({}, Gu, {
    deltaX: function(t) {
      return "deltaX" in t ? t.deltaX : "wheelDeltaX" in t ? -t.wheelDeltaX : 0;
    },
    deltaY: function(t) {
      return "deltaY" in t ? t.deltaY : "wheelDeltaY" in t ? -t.wheelDeltaY : "wheelDelta" in t ? -t.wheelDelta : 0;
    },
    deltaZ: 0,
    deltaMode: 0
  }), Mg = Ce(Ng), Rg = H({}, vn, {
    newState: 0,
    oldState: 0
  }), zg = Ce(Rg), Dg = [9, 13, 27, 32], ec = El && "CompositionEvent" in window, Ha = null;
  El && "documentMode" in document && (Ha = document.documentMode);
  var Cg = El && "TextEvent" in window && !Ha, os = El && (!ec || Ha && 8 < Ha && 11 >= Ha), rs = " ", ds = !1;
  function gs(t, e) {
    switch (t) {
      case "keyup":
        return Dg.indexOf(e.keyCode) !== -1;
      case "keydown":
        return e.keyCode !== 229;
      case "keypress":
      case "mousedown":
      case "focusout":
        return !0;
      default:
        return !1;
    }
  }
  function ms(t) {
    return t = t.detail, typeof t == "object" && "data" in t ? t.data : null;
  }
  var Qn = !1;
  function Ug(t, e) {
    switch (t) {
      case "compositionend":
        return ms(e);
      case "keypress":
        return e.which !== 32 ? null : (ds = !0, rs);
      case "textInput":
        return t = e.data, t === rs && ds ? null : t;
      default:
        return null;
    }
  }
  function xg(t, e) {
    if (Qn)
      return t === "compositionend" || !ec && gs(t, e) ? (t = us(), xu = Wi = wl = null, Qn = !1, t) : null;
    switch (t) {
      case "paste":
        return null;
      case "keypress":
        if (!(e.ctrlKey || e.altKey || e.metaKey) || e.ctrlKey && e.altKey) {
          if (e.char && 1 < e.char.length)
            return e.char;
          if (e.which) return String.fromCharCode(e.which);
        }
        return null;
      case "compositionend":
        return os && e.locale !== "ko" ? null : e.data;
      default:
        return null;
    }
  }
  var Bg = {
    color: !0,
    date: !0,
    datetime: !0,
    "datetime-local": !0,
    email: !0,
    month: !0,
    number: !0,
    password: !0,
    range: !0,
    search: !0,
    tel: !0,
    text: !0,
    time: !0,
    url: !0,
    week: !0
  };
  function hs(t) {
    var e = t && t.nodeName && t.nodeName.toLowerCase();
    return e === "input" ? !!Bg[t.type] : e === "textarea";
  }
  function bs(t, e, l, n) {
    bt ? kt ? kt.push(n) : kt = [n] : bt = n, e = Ni(e, "onChange"), 0 < e.length && (l = new Lu(
      "onChange",
      "change",
      null,
      l,
      n
    ), t.push({ event: l, listeners: e }));
  }
  var La = null, Ga = null;
  function Hg(t) {
    Pr(t, 0);
  }
  function qu(t) {
    var e = Ll(t);
    if (Ma(e)) return t;
  }
  function ys(t, e) {
    if (t === "change") return e;
  }
  var vs = !1;
  if (El) {
    var lc;
    if (El) {
      var nc = "oninput" in document;
      if (!nc) {
        var Es = document.createElement("div");
        Es.setAttribute("oninput", "return;"), nc = typeof Es.oninput == "function";
      }
      lc = nc;
    } else lc = !1;
    vs = lc && (!document.documentMode || 9 < document.documentMode);
  }
  function ps() {
    La && (La.detachEvent("onpropertychange", Ss), Ga = La = null);
  }
  function Ss(t) {
    if (t.propertyName === "value" && qu(Ga)) {
      var e = [];
      bs(
        e,
        Ga,
        t,
        it(t)
      ), Uu(Hg, e);
    }
  }
  function Lg(t, e, l) {
    t === "focusin" ? (ps(), La = e, Ga = l, La.attachEvent("onpropertychange", Ss)) : t === "focusout" && ps();
  }
  function Gg(t) {
    if (t === "selectionchange" || t === "keyup" || t === "keydown")
      return qu(Ga);
  }
  function qg(t, e) {
    if (t === "click") return qu(e);
  }
  function Yg(t, e) {
    if (t === "input" || t === "change")
      return qu(e);
  }
  function wg(t, e) {
    return t === e && (t !== 0 || 1 / t === 1 / e) || t !== t && e !== e;
  }
  var Xe = typeof Object.is == "function" ? Object.is : wg;
  function qa(t, e) {
    if (Xe(t, e)) return !0;
    if (typeof t != "object" || t === null || typeof e != "object" || e === null)
      return !1;
    var l = Object.keys(t), n = Object.keys(e);
    if (l.length !== n.length) return !1;
    for (n = 0; n < l.length; n++) {
      var a = l[n];
      if (!_a.call(e, a) || !Xe(t[a], e[a]))
        return !1;
    }
    return !0;
  }
  function _s(t) {
    for (; t && t.firstChild; ) t = t.firstChild;
    return t;
  }
  function Ts(t, e) {
    var l = _s(t);
    t = 0;
    for (var n; l; ) {
      if (l.nodeType === 3) {
        if (n = t + l.textContent.length, t <= e && n >= e)
          return { node: l, offset: e - t };
        t = n;
      }
      t: {
        for (; l; ) {
          if (l.nextSibling) {
            l = l.nextSibling;
            break t;
          }
          l = l.parentNode;
        }
        l = void 0;
      }
      l = _s(l);
    }
  }
  function As(t, e) {
    return t && e ? t === e ? !0 : t && t.nodeType === 3 ? !1 : e && e.nodeType === 3 ? As(t, e.parentNode) : "contains" in t ? t.contains(e) : t.compareDocumentPosition ? !!(t.compareDocumentPosition(e) & 16) : !1 : !1;
  }
  function Os(t) {
    t = t != null && t.ownerDocument != null && t.ownerDocument.defaultView != null ? t.ownerDocument.defaultView : window;
    for (var e = Xn(t.document); e instanceof t.HTMLIFrameElement; ) {
      try {
        var l = typeof e.contentWindow.location.href == "string";
      } catch {
        l = !1;
      }
      if (l) t = e.contentWindow;
      else break;
      e = Xn(t.document);
    }
    return e;
  }
  function ac(t) {
    var e = t && t.nodeName && t.nodeName.toLowerCase();
    return e && (e === "input" && (t.type === "text" || t.type === "search" || t.type === "tel" || t.type === "url" || t.type === "password") || e === "textarea" || t.contentEditable === "true");
  }
  var Xg = El && "documentMode" in document && 11 >= document.documentMode, Kn = null, uc = null, Ya = null, ic = !1;
  function Ns(t, e, l) {
    var n = l.window === l ? l.document : l.nodeType === 9 ? l : l.ownerDocument;
    ic || Kn == null || Kn !== Xn(n) || (n = Kn, "selectionStart" in n && ac(n) ? n = { start: n.selectionStart, end: n.selectionEnd } : (n = (n.ownerDocument && n.ownerDocument.defaultView || window).getSelection(), n = {
      anchorNode: n.anchorNode,
      anchorOffset: n.anchorOffset,
      focusNode: n.focusNode,
      focusOffset: n.focusOffset
    }), Ya && qa(Ya, n) || (Ya = n, n = Ni(uc, "onSelect"), 0 < n.length && (e = new Lu(
      "onSelect",
      "select",
      null,
      e,
      l
    ), t.push({ event: e, listeners: n }), e.target = Kn)));
  }
  function En(t, e) {
    var l = {};
    return l[t.toLowerCase()] = e.toLowerCase(), l["Webkit" + t] = "webkit" + e, l["Moz" + t] = "moz" + e, l;
  }
  var Vn = {
    animationend: En("Animation", "AnimationEnd"),
    animationiteration: En("Animation", "AnimationIteration"),
    animationstart: En("Animation", "AnimationStart"),
    transitionrun: En("Transition", "TransitionRun"),
    transitionstart: En("Transition", "TransitionStart"),
    transitioncancel: En("Transition", "TransitionCancel"),
    transitionend: En("Transition", "TransitionEnd")
  }, cc = {}, Ms = {};
  El && (Ms = document.createElement("div").style, "AnimationEvent" in window || (delete Vn.animationend.animation, delete Vn.animationiteration.animation, delete Vn.animationstart.animation), "TransitionEvent" in window || delete Vn.transitionend.transition);
  function pn(t) {
    if (cc[t]) return cc[t];
    if (!Vn[t]) return t;
    var e = Vn[t], l;
    for (l in e)
      if (e.hasOwnProperty(l) && l in Ms)
        return cc[t] = e[l];
    return t;
  }
  var Rs = pn("animationend"), zs = pn("animationiteration"), Ds = pn("animationstart"), Zg = pn("transitionrun"), jg = pn("transitionstart"), Qg = pn("transitioncancel"), Cs = pn("transitionend"), Us = /* @__PURE__ */ new Map(), fc = "abort auxClick beforeToggle cancel canPlay canPlayThrough click close contextMenu copy cut drag dragEnd dragEnter dragExit dragLeave dragOver dragStart drop durationChange emptied encrypted ended error gotPointerCapture input invalid keyDown keyPress keyUp load loadedData loadedMetadata loadStart lostPointerCapture mouseDown mouseMove mouseOut mouseOver mouseUp paste pause play playing pointerCancel pointerDown pointerMove pointerOut pointerOver pointerUp progress rateChange reset resize seeked seeking stalled submit suspend timeUpdate touchCancel touchEnd touchStart volumeChange scroll toggle touchMove waiting wheel".split(
    " "
  );
  fc.push("scrollEnd");
  function nl(t, e) {
    Us.set(t, e), yl(e, [t]);
  }
  var Yu = typeof reportError == "function" ? reportError : function(t) {
    if (typeof window == "object" && typeof window.ErrorEvent == "function") {
      var e = new window.ErrorEvent("error", {
        bubbles: !0,
        cancelable: !0,
        message: typeof t == "object" && t !== null && typeof t.message == "string" ? String(t.message) : String(t),
        error: t
      });
      if (!window.dispatchEvent(e)) return;
    } else if (typeof process == "object" && typeof process.emit == "function") {
      process.emit("uncaughtException", t);
      return;
    }
    console.error(t);
  }, $e = [], kn = 0, sc = 0;
  function wu() {
    for (var t = kn, e = sc = kn = 0; e < t; ) {
      var l = $e[e];
      $e[e++] = null;
      var n = $e[e];
      $e[e++] = null;
      var a = $e[e];
      $e[e++] = null;
      var u = $e[e];
      if ($e[e++] = null, n !== null && a !== null) {
        var i = n.pending;
        i === null ? a.next = a : (a.next = i.next, i.next = a), n.pending = a;
      }
      u !== 0 && xs(l, a, u);
    }
  }
  function Xu(t, e, l, n) {
    $e[kn++] = t, $e[kn++] = e, $e[kn++] = l, $e[kn++] = n, sc |= n, t.lanes |= n, t = t.alternate, t !== null && (t.lanes |= n);
  }
  function oc(t, e, l, n) {
    return Xu(t, e, l, n), Zu(t);
  }
  function Sn(t, e) {
    return Xu(t, null, null, e), Zu(t);
  }
  function xs(t, e, l) {
    t.lanes |= l;
    var n = t.alternate;
    n !== null && (n.lanes |= l);
    for (var a = !1, u = t.return; u !== null; )
      u.childLanes |= l, n = u.alternate, n !== null && (n.childLanes |= l), u.tag === 22 && (t = u.stateNode, t === null || t._visibility & 1 || (a = !0)), t = u, u = u.return;
    return t.tag === 3 ? (u = t.stateNode, a && e !== null && (a = 31 - Oe(l), t = u.hiddenUpdates, n = t[a], n === null ? t[a] = [e] : n.push(e), e.lane = l | 536870912), u) : null;
  }
  function Zu(t) {
    if (50 < cu)
      throw cu = 0, pf = null, Error(r(185));
    for (var e = t.return; e !== null; )
      t = e, e = t.return;
    return t.tag === 3 ? t.stateNode : null;
  }
  var Jn = {};
  function Kg(t, e, l, n) {
    this.tag = t, this.key = l, this.sibling = this.child = this.return = this.stateNode = this.type = this.elementType = null, this.index = 0, this.refCleanup = this.ref = null, this.pendingProps = e, this.dependencies = this.memoizedState = this.updateQueue = this.memoizedProps = null, this.mode = n, this.subtreeFlags = this.flags = 0, this.deletions = null, this.childLanes = this.lanes = 0, this.alternate = null;
  }
  function Ze(t, e, l, n) {
    return new Kg(t, e, l, n);
  }
  function rc(t) {
    return t = t.prototype, !(!t || !t.isReactComponent);
  }
  function pl(t, e) {
    var l = t.alternate;
    return l === null ? (l = Ze(
      t.tag,
      e,
      t.key,
      t.mode
    ), l.elementType = t.elementType, l.type = t.type, l.stateNode = t.stateNode, l.alternate = t, t.alternate = l) : (l.pendingProps = e, l.type = t.type, l.flags = 0, l.subtreeFlags = 0, l.deletions = null), l.flags = t.flags & 65011712, l.childLanes = t.childLanes, l.lanes = t.lanes, l.child = t.child, l.memoizedProps = t.memoizedProps, l.memoizedState = t.memoizedState, l.updateQueue = t.updateQueue, e = t.dependencies, l.dependencies = e === null ? null : { lanes: e.lanes, firstContext: e.firstContext }, l.sibling = t.sibling, l.index = t.index, l.ref = t.ref, l.refCleanup = t.refCleanup, l;
  }
  function Bs(t, e) {
    t.flags &= 65011714;
    var l = t.alternate;
    return l === null ? (t.childLanes = 0, t.lanes = e, t.child = null, t.subtreeFlags = 0, t.memoizedProps = null, t.memoizedState = null, t.updateQueue = null, t.dependencies = null, t.stateNode = null) : (t.childLanes = l.childLanes, t.lanes = l.lanes, t.child = l.child, t.subtreeFlags = 0, t.deletions = null, t.memoizedProps = l.memoizedProps, t.memoizedState = l.memoizedState, t.updateQueue = l.updateQueue, t.type = l.type, e = l.dependencies, t.dependencies = e === null ? null : {
      lanes: e.lanes,
      firstContext: e.firstContext
    }), t;
  }
  function ju(t, e, l, n, a, u) {
    var i = 0;
    if (n = t, typeof t == "function") rc(t) && (i = 1);
    else if (typeof t == "string")
      i = Wm(
        t,
        l,
        q.current
      ) ? 26 : t === "html" || t === "head" || t === "body" ? 27 : 5;
    else
      t: switch (t) {
        case Qt:
          return t = Ze(31, l, e, a), t.elementType = Qt, t.lanes = u, t;
        case F:
          return _n(l.children, a, u, e);
        case Mt:
          i = 8, a |= 24;
          break;
        case ht:
          return t = Ze(12, l, e, a | 2), t.elementType = ht, t.lanes = u, t;
        case St:
          return t = Ze(13, l, e, a), t.elementType = St, t.lanes = u, t;
        case pt:
          return t = Ze(19, l, e, a), t.elementType = pt, t.lanes = u, t;
        default:
          if (typeof t == "object" && t !== null)
            switch (t.$$typeof) {
              case Nt:
                i = 10;
                break t;
              case Ht:
                i = 9;
                break t;
              case jt:
                i = 11;
                break t;
              case tt:
                i = 14;
                break t;
              case qt:
                i = 16, n = null;
                break t;
            }
          i = 29, l = Error(
            r(130, t === null ? "null" : typeof t, "")
          ), n = null;
      }
    return e = Ze(i, l, e, a), e.elementType = t, e.type = n, e.lanes = u, e;
  }
  function _n(t, e, l, n) {
    return t = Ze(7, t, n, e), t.lanes = l, t;
  }
  function dc(t, e, l) {
    return t = Ze(6, t, null, e), t.lanes = l, t;
  }
  function Hs(t) {
    var e = Ze(18, null, null, 0);
    return e.stateNode = t, e;
  }
  function gc(t, e, l) {
    return e = Ze(
      4,
      t.children !== null ? t.children : [],
      t.key,
      e
    ), e.lanes = l, e.stateNode = {
      containerInfo: t.containerInfo,
      pendingChildren: null,
      implementation: t.implementation
    }, e;
  }
  var Ls = /* @__PURE__ */ new WeakMap();
  function We(t, e) {
    if (typeof t == "object" && t !== null) {
      var l = Ls.get(t);
      return l !== void 0 ? l : (e = {
        value: t,
        source: e,
        stack: Su(e)
      }, Ls.set(t, e), e);
    }
    return {
      value: t,
      source: e,
      stack: Su(e)
    };
  }
  var $n = [], Wn = 0, Qu = null, wa = 0, Ie = [], Fe = 0, Xl = null, sl = 1, ol = "";
  function Sl(t, e) {
    $n[Wn++] = wa, $n[Wn++] = Qu, Qu = t, wa = e;
  }
  function Gs(t, e, l) {
    Ie[Fe++] = sl, Ie[Fe++] = ol, Ie[Fe++] = Xl, Xl = t;
    var n = sl;
    t = ol;
    var a = 32 - Oe(n) - 1;
    n &= ~(1 << a), l += 1;
    var u = 32 - Oe(e) + a;
    if (30 < u) {
      var i = a - a % 5;
      u = (n & (1 << i) - 1).toString(32), n >>= i, a -= i, sl = 1 << 32 - Oe(e) + a | l << a | n, ol = u + t;
    } else
      sl = 1 << u | l << a | n, ol = t;
  }
  function mc(t) {
    t.return !== null && (Sl(t, 1), Gs(t, 1, 0));
  }
  function hc(t) {
    for (; t === Qu; )
      Qu = $n[--Wn], $n[Wn] = null, wa = $n[--Wn], $n[Wn] = null;
    for (; t === Xl; )
      Xl = Ie[--Fe], Ie[Fe] = null, ol = Ie[--Fe], Ie[Fe] = null, sl = Ie[--Fe], Ie[Fe] = null;
  }
  function qs(t, e) {
    Ie[Fe++] = sl, Ie[Fe++] = ol, Ie[Fe++] = Xl, sl = e.id, ol = e.overflow, Xl = t;
  }
  var ye = null, Xt = null, Et = !1, Zl = null, Pe = !1, bc = Error(r(519));
  function jl(t) {
    var e = Error(
      r(
        418,
        1 < arguments.length && arguments[1] !== void 0 && arguments[1] ? "text" : "HTML",
        ""
      )
    );
    throw Xa(We(e, t)), bc;
  }
  function Ys(t) {
    var e = t.stateNode, l = t.type, n = t.memoizedProps;
    switch (e[Pt] = t, e[_e] = n, l) {
      case "dialog":
        mt("cancel", e), mt("close", e);
        break;
      case "iframe":
      case "object":
      case "embed":
        mt("load", e);
        break;
      case "video":
      case "audio":
        for (l = 0; l < su.length; l++)
          mt(su[l], e);
        break;
      case "source":
        mt("error", e);
        break;
      case "img":
      case "image":
      case "link":
        mt("error", e), mt("load", e);
        break;
      case "details":
        mt("toggle", e);
        break;
      case "input":
        mt("invalid", e), yn(
          e,
          n.value,
          n.defaultValue,
          n.checked,
          n.defaultChecked,
          n.type,
          n.name,
          !0
        );
        break;
      case "select":
        mt("invalid", e);
        break;
      case "textarea":
        mt("invalid", e), jn(e, n.value, n.defaultValue, n.children);
    }
    l = n.children, typeof l != "string" && typeof l != "number" && typeof l != "bigint" || e.textContent === "" + l || n.suppressHydrationWarning === !0 || nd(e.textContent, l) ? (n.popover != null && (mt("beforetoggle", e), mt("toggle", e)), n.onScroll != null && mt("scroll", e), n.onScrollEnd != null && mt("scrollend", e), n.onClick != null && (e.onclick = D), e = !0) : e = !1, e || jl(t, !0);
  }
  function ws(t) {
    for (ye = t.return; ye; )
      switch (ye.tag) {
        case 5:
        case 31:
        case 13:
          Pe = !1;
          return;
        case 27:
        case 3:
          Pe = !0;
          return;
        default:
          ye = ye.return;
      }
  }
  function In(t) {
    if (t !== ye) return !1;
    if (!Et) return ws(t), Et = !0, !1;
    var e = t.tag, l;
    if ((l = e !== 3 && e !== 27) && ((l = e === 5) && (l = t.type, l = !(l !== "form" && l !== "button") || Hf(t.type, t.memoizedProps)), l = !l), l && Xt && jl(t), ws(t), e === 13) {
      if (t = t.memoizedState, t = t !== null ? t.dehydrated : null, !t) throw Error(r(317));
      Xt = dd(t);
    } else if (e === 31) {
      if (t = t.memoizedState, t = t !== null ? t.dehydrated : null, !t) throw Error(r(317));
      Xt = dd(t);
    } else
      e === 27 ? (e = Xt, nn(t.type) ? (t = wf, wf = null, Xt = t) : Xt = e) : Xt = ye ? el(t.stateNode.nextSibling) : null;
    return !0;
  }
  function Tn() {
    Xt = ye = null, Et = !1;
  }
  function yc() {
    var t = Zl;
    return t !== null && (He === null ? He = t : He.push.apply(
      He,
      t
    ), Zl = null), t;
  }
  function Xa(t) {
    Zl === null ? Zl = [t] : Zl.push(t);
  }
  var vc = o(null), An = null, _l = null;
  function Ql(t, e, l) {
    C(vc, e._currentValue), e._currentValue = l;
  }
  function Tl(t) {
    t._currentValue = vc.current, _(vc);
  }
  function Ec(t, e, l) {
    for (; t !== null; ) {
      var n = t.alternate;
      if ((t.childLanes & e) !== e ? (t.childLanes |= e, n !== null && (n.childLanes |= e)) : n !== null && (n.childLanes & e) !== e && (n.childLanes |= e), t === l) break;
      t = t.return;
    }
  }
  function pc(t, e, l, n) {
    var a = t.child;
    for (a !== null && (a.return = t); a !== null; ) {
      var u = a.dependencies;
      if (u !== null) {
        var i = a.child;
        u = u.firstContext;
        t: for (; u !== null; ) {
          var c = u;
          u = a;
          for (var f = 0; f < e.length; f++)
            if (c.context === e[f]) {
              u.lanes |= l, c = u.alternate, c !== null && (c.lanes |= l), Ec(
                u.return,
                l,
                t
              ), n || (i = null);
              break t;
            }
          u = c.next;
        }
      } else if (a.tag === 18) {
        if (i = a.return, i === null) throw Error(r(341));
        i.lanes |= l, u = i.alternate, u !== null && (u.lanes |= l), Ec(i, l, t), i = null;
      } else i = a.child;
      if (i !== null) i.return = a;
      else
        for (i = a; i !== null; ) {
          if (i === t) {
            i = null;
            break;
          }
          if (a = i.sibling, a !== null) {
            a.return = i.return, i = a;
            break;
          }
          i = i.return;
        }
      a = i;
    }
  }
  function Fn(t, e, l, n) {
    t = null;
    for (var a = e, u = !1; a !== null; ) {
      if (!u) {
        if (a.flags & 524288) u = !0;
        else if (a.flags & 262144) break;
      }
      if (a.tag === 10) {
        var i = a.alternate;
        if (i === null) throw Error(r(387));
        if (i = i.memoizedProps, i !== null) {
          var c = a.type;
          Xe(a.pendingProps.value, i.value) || (t !== null ? t.push(c) : t = [c]);
        }
      } else if (a === _t.current) {
        if (i = a.alternate, i === null) throw Error(r(387));
        i.memoizedState.memoizedState !== a.memoizedState.memoizedState && (t !== null ? t.push(mu) : t = [mu]);
      }
      a = a.return;
    }
    t !== null && pc(
      e,
      t,
      l,
      n
    ), e.flags |= 262144;
  }
  function Ku(t) {
    for (t = t.firstContext; t !== null; ) {
      if (!Xe(
        t.context._currentValue,
        t.memoizedValue
      ))
        return !0;
      t = t.next;
    }
    return !1;
  }
  function On(t) {
    An = t, _l = null, t = t.dependencies, t !== null && (t.firstContext = null);
  }
  function ve(t) {
    return Xs(An, t);
  }
  function Vu(t, e) {
    return An === null && On(t), Xs(t, e);
  }
  function Xs(t, e) {
    var l = e._currentValue;
    if (e = { context: e, memoizedValue: l, next: null }, _l === null) {
      if (t === null) throw Error(r(308));
      _l = e, t.dependencies = { lanes: 0, firstContext: e }, t.flags |= 524288;
    } else _l = _l.next = e;
    return l;
  }
  var Vg = typeof AbortController < "u" ? AbortController : function() {
    var t = [], e = this.signal = {
      aborted: !1,
      addEventListener: function(l, n) {
        t.push(n);
      }
    };
    this.abort = function() {
      e.aborted = !0, t.forEach(function(l) {
        return l();
      });
    };
  }, kg = g.unstable_scheduleCallback, Jg = g.unstable_NormalPriority, ie = {
    $$typeof: Nt,
    Consumer: null,
    Provider: null,
    _currentValue: null,
    _currentValue2: null,
    _threadCount: 0
  };
  function Sc() {
    return {
      controller: new Vg(),
      data: /* @__PURE__ */ new Map(),
      refCount: 0
    };
  }
  function Za(t) {
    t.refCount--, t.refCount === 0 && kg(Jg, function() {
      t.controller.abort();
    });
  }
  var ja = null, _c = 0, Pn = 0, ta = null;
  function $g(t, e) {
    if (ja === null) {
      var l = ja = [];
      _c = 0, Pn = Nf(), ta = {
        status: "pending",
        value: void 0,
        then: function(n) {
          l.push(n);
        }
      };
    }
    return _c++, e.then(Zs, Zs), e;
  }
  function Zs() {
    if (--_c === 0 && ja !== null) {
      ta !== null && (ta.status = "fulfilled");
      var t = ja;
      ja = null, Pn = 0, ta = null;
      for (var e = 0; e < t.length; e++) (0, t[e])();
    }
  }
  function Wg(t, e) {
    var l = [], n = {
      status: "pending",
      value: null,
      reason: null,
      then: function(a) {
        l.push(a);
      }
    };
    return t.then(
      function() {
        n.status = "fulfilled", n.value = e;
        for (var a = 0; a < l.length; a++) (0, l[a])(e);
      },
      function(a) {
        for (n.status = "rejected", n.reason = a, a = 0; a < l.length; a++)
          (0, l[a])(void 0);
      }
    ), n;
  }
  var js = p.S;
  p.S = function(t, e) {
    Mr = It(), typeof e == "object" && e !== null && typeof e.then == "function" && $g(t, e), js !== null && js(t, e);
  };
  var Nn = o(null);
  function Tc() {
    var t = Nn.current;
    return t !== null ? t : Gt.pooledCache;
  }
  function ku(t, e) {
    e === null ? C(Nn, Nn.current) : C(Nn, e.pool);
  }
  function Qs() {
    var t = Tc();
    return t === null ? null : { parent: ie._currentValue, pool: t };
  }
  var ea = Error(r(460)), Ac = Error(r(474)), Ju = Error(r(542)), $u = { then: function() {
  } };
  function Ks(t) {
    return t = t.status, t === "fulfilled" || t === "rejected";
  }
  function Vs(t, e, l) {
    switch (l = t[l], l === void 0 ? t.push(e) : l !== e && (e.then(D, D), e = l), e.status) {
      case "fulfilled":
        return e.value;
      case "rejected":
        throw t = e.reason, Js(t), t;
      default:
        if (typeof e.status == "string") e.then(D, D);
        else {
          if (t = Gt, t !== null && 100 < t.shellSuspendCounter)
            throw Error(r(482));
          t = e, t.status = "pending", t.then(
            function(n) {
              if (e.status === "pending") {
                var a = e;
                a.status = "fulfilled", a.value = n;
              }
            },
            function(n) {
              if (e.status === "pending") {
                var a = e;
                a.status = "rejected", a.reason = n;
              }
            }
          );
        }
        switch (e.status) {
          case "fulfilled":
            return e.value;
          case "rejected":
            throw t = e.reason, Js(t), t;
        }
        throw Rn = e, ea;
    }
  }
  function Mn(t) {
    try {
      var e = t._init;
      return e(t._payload);
    } catch (l) {
      throw l !== null && typeof l == "object" && typeof l.then == "function" ? (Rn = l, ea) : l;
    }
  }
  var Rn = null;
  function ks() {
    if (Rn === null) throw Error(r(459));
    var t = Rn;
    return Rn = null, t;
  }
  function Js(t) {
    if (t === ea || t === Ju)
      throw Error(r(483));
  }
  var la = null, Qa = 0;
  function Wu(t) {
    var e = Qa;
    return Qa += 1, la === null && (la = []), Vs(la, t, e);
  }
  function Ka(t, e) {
    e = e.props.ref, t.ref = e !== void 0 ? e : null;
  }
  function Iu(t, e) {
    throw e.$$typeof === Z ? Error(r(525)) : (t = Object.prototype.toString.call(e), Error(
      r(
        31,
        t === "[object Object]" ? "object with keys {" + Object.keys(e).join(", ") + "}" : t
      )
    ));
  }
  function $s(t) {
    function e(m, d) {
      if (t) {
        var h = m.deletions;
        h === null ? (m.deletions = [d], m.flags |= 16) : h.push(d);
      }
    }
    function l(m, d) {
      if (!t) return null;
      for (; d !== null; )
        e(m, d), d = d.sibling;
      return null;
    }
    function n(m) {
      for (var d = /* @__PURE__ */ new Map(); m !== null; )
        m.key !== null ? d.set(m.key, m) : d.set(m.index, m), m = m.sibling;
      return d;
    }
    function a(m, d) {
      return m = pl(m, d), m.index = 0, m.sibling = null, m;
    }
    function u(m, d, h) {
      return m.index = h, t ? (h = m.alternate, h !== null ? (h = h.index, h < d ? (m.flags |= 67108866, d) : h) : (m.flags |= 67108866, d)) : (m.flags |= 1048576, d);
    }
    function i(m) {
      return t && m.alternate === null && (m.flags |= 67108866), m;
    }
    function c(m, d, h, A) {
      return d === null || d.tag !== 6 ? (d = dc(h, m.mode, A), d.return = m, d) : (d = a(d, h), d.return = m, d);
    }
    function f(m, d, h, A) {
      var K = h.type;
      return K === F ? S(
        m,
        d,
        h.props.children,
        A,
        h.key
      ) : d !== null && (d.elementType === K || typeof K == "object" && K !== null && K.$$typeof === qt && Mn(K) === d.type) ? (d = a(d, h.props), Ka(d, h), d.return = m, d) : (d = ju(
        h.type,
        h.key,
        h.props,
        null,
        m.mode,
        A
      ), Ka(d, h), d.return = m, d);
    }
    function b(m, d, h, A) {
      return d === null || d.tag !== 4 || d.stateNode.containerInfo !== h.containerInfo || d.stateNode.implementation !== h.implementation ? (d = gc(h, m.mode, A), d.return = m, d) : (d = a(d, h.children || []), d.return = m, d);
    }
    function S(m, d, h, A, K) {
      return d === null || d.tag !== 7 ? (d = _n(
        h,
        m.mode,
        A,
        K
      ), d.return = m, d) : (d = a(d, h), d.return = m, d);
    }
    function O(m, d, h) {
      if (typeof d == "string" && d !== "" || typeof d == "number" || typeof d == "bigint")
        return d = dc(
          "" + d,
          m.mode,
          h
        ), d.return = m, d;
      if (typeof d == "object" && d !== null) {
        switch (d.$$typeof) {
          case ut:
            return h = ju(
              d.type,
              d.key,
              d.props,
              null,
              m.mode,
              h
            ), Ka(h, d), h.return = m, h;
          case rt:
            return d = gc(
              d,
              m.mode,
              h
            ), d.return = m, d;
          case qt:
            return d = Mn(d), O(m, d, h);
        }
        if (me(d) || ne(d))
          return d = _n(
            d,
            m.mode,
            h,
            null
          ), d.return = m, d;
        if (typeof d.then == "function")
          return O(m, Wu(d), h);
        if (d.$$typeof === Nt)
          return O(
            m,
            Vu(m, d),
            h
          );
        Iu(m, d);
      }
      return null;
    }
    function y(m, d, h, A) {
      var K = d !== null ? d.key : null;
      if (typeof h == "string" && h !== "" || typeof h == "number" || typeof h == "bigint")
        return K !== null ? null : c(m, d, "" + h, A);
      if (typeof h == "object" && h !== null) {
        switch (h.$$typeof) {
          case ut:
            return h.key === K ? f(m, d, h, A) : null;
          case rt:
            return h.key === K ? b(m, d, h, A) : null;
          case qt:
            return h = Mn(h), y(m, d, h, A);
        }
        if (me(h) || ne(h))
          return K !== null ? null : S(m, d, h, A, null);
        if (typeof h.then == "function")
          return y(
            m,
            d,
            Wu(h),
            A
          );
        if (h.$$typeof === Nt)
          return y(
            m,
            d,
            Vu(m, h),
            A
          );
        Iu(m, h);
      }
      return null;
    }
    function v(m, d, h, A, K) {
      if (typeof A == "string" && A !== "" || typeof A == "number" || typeof A == "bigint")
        return m = m.get(h) || null, c(d, m, "" + A, K);
      if (typeof A == "object" && A !== null) {
        switch (A.$$typeof) {
          case ut:
            return m = m.get(
              A.key === null ? h : A.key
            ) || null, f(d, m, A, K);
          case rt:
            return m = m.get(
              A.key === null ? h : A.key
            ) || null, b(d, m, A, K);
          case qt:
            return A = Mn(A), v(
              m,
              d,
              h,
              A,
              K
            );
        }
        if (me(A) || ne(A))
          return m = m.get(h) || null, S(d, m, A, K, null);
        if (typeof A.then == "function")
          return v(
            m,
            d,
            h,
            Wu(A),
            K
          );
        if (A.$$typeof === Nt)
          return v(
            m,
            d,
            h,
            Vu(d, A),
            K
          );
        Iu(d, A);
      }
      return null;
    }
    function G(m, d, h, A) {
      for (var K = null, Tt = null, X = d, st = d = 0, vt = null; X !== null && st < h.length; st++) {
        X.index > st ? (vt = X, X = null) : vt = X.sibling;
        var At = y(
          m,
          X,
          h[st],
          A
        );
        if (At === null) {
          X === null && (X = vt);
          break;
        }
        t && X && At.alternate === null && e(m, X), d = u(At, d, st), Tt === null ? K = At : Tt.sibling = At, Tt = At, X = vt;
      }
      if (st === h.length)
        return l(m, X), Et && Sl(m, st), K;
      if (X === null) {
        for (; st < h.length; st++)
          X = O(m, h[st], A), X !== null && (d = u(
            X,
            d,
            st
          ), Tt === null ? K = X : Tt.sibling = X, Tt = X);
        return Et && Sl(m, st), K;
      }
      for (X = n(X); st < h.length; st++)
        vt = v(
          X,
          m,
          st,
          h[st],
          A
        ), vt !== null && (t && vt.alternate !== null && X.delete(
          vt.key === null ? st : vt.key
        ), d = u(
          vt,
          d,
          st
        ), Tt === null ? K = vt : Tt.sibling = vt, Tt = vt);
      return t && X.forEach(function(sn) {
        return e(m, sn);
      }), Et && Sl(m, st), K;
    }
    function k(m, d, h, A) {
      if (h == null) throw Error(r(151));
      for (var K = null, Tt = null, X = d, st = d = 0, vt = null, At = h.next(); X !== null && !At.done; st++, At = h.next()) {
        X.index > st ? (vt = X, X = null) : vt = X.sibling;
        var sn = y(m, X, At.value, A);
        if (sn === null) {
          X === null && (X = vt);
          break;
        }
        t && X && sn.alternate === null && e(m, X), d = u(sn, d, st), Tt === null ? K = sn : Tt.sibling = sn, Tt = sn, X = vt;
      }
      if (At.done)
        return l(m, X), Et && Sl(m, st), K;
      if (X === null) {
        for (; !At.done; st++, At = h.next())
          At = O(m, At.value, A), At !== null && (d = u(At, d, st), Tt === null ? K = At : Tt.sibling = At, Tt = At);
        return Et && Sl(m, st), K;
      }
      for (X = n(X); !At.done; st++, At = h.next())
        At = v(X, m, st, At.value, A), At !== null && (t && At.alternate !== null && X.delete(At.key === null ? st : At.key), d = u(At, d, st), Tt === null ? K = At : Tt.sibling = At, Tt = At);
      return t && X.forEach(function(ch) {
        return e(m, ch);
      }), Et && Sl(m, st), K;
    }
    function Bt(m, d, h, A) {
      if (typeof h == "object" && h !== null && h.type === F && h.key === null && (h = h.props.children), typeof h == "object" && h !== null) {
        switch (h.$$typeof) {
          case ut:
            t: {
              for (var K = h.key; d !== null; ) {
                if (d.key === K) {
                  if (K = h.type, K === F) {
                    if (d.tag === 7) {
                      l(
                        m,
                        d.sibling
                      ), A = a(
                        d,
                        h.props.children
                      ), A.return = m, m = A;
                      break t;
                    }
                  } else if (d.elementType === K || typeof K == "object" && K !== null && K.$$typeof === qt && Mn(K) === d.type) {
                    l(
                      m,
                      d.sibling
                    ), A = a(d, h.props), Ka(A, h), A.return = m, m = A;
                    break t;
                  }
                  l(m, d);
                  break;
                } else e(m, d);
                d = d.sibling;
              }
              h.type === F ? (A = _n(
                h.props.children,
                m.mode,
                A,
                h.key
              ), A.return = m, m = A) : (A = ju(
                h.type,
                h.key,
                h.props,
                null,
                m.mode,
                A
              ), Ka(A, h), A.return = m, m = A);
            }
            return i(m);
          case rt:
            t: {
              for (K = h.key; d !== null; ) {
                if (d.key === K)
                  if (d.tag === 4 && d.stateNode.containerInfo === h.containerInfo && d.stateNode.implementation === h.implementation) {
                    l(
                      m,
                      d.sibling
                    ), A = a(d, h.children || []), A.return = m, m = A;
                    break t;
                  } else {
                    l(m, d);
                    break;
                  }
                else e(m, d);
                d = d.sibling;
              }
              A = gc(h, m.mode, A), A.return = m, m = A;
            }
            return i(m);
          case qt:
            return h = Mn(h), Bt(
              m,
              d,
              h,
              A
            );
        }
        if (me(h))
          return G(
            m,
            d,
            h,
            A
          );
        if (ne(h)) {
          if (K = ne(h), typeof K != "function") throw Error(r(150));
          return h = K.call(h), k(
            m,
            d,
            h,
            A
          );
        }
        if (typeof h.then == "function")
          return Bt(
            m,
            d,
            Wu(h),
            A
          );
        if (h.$$typeof === Nt)
          return Bt(
            m,
            d,
            Vu(m, h),
            A
          );
        Iu(m, h);
      }
      return typeof h == "string" && h !== "" || typeof h == "number" || typeof h == "bigint" ? (h = "" + h, d !== null && d.tag === 6 ? (l(m, d.sibling), A = a(d, h), A.return = m, m = A) : (l(m, d), A = dc(h, m.mode, A), A.return = m, m = A), i(m)) : l(m, d);
    }
    return function(m, d, h, A) {
      try {
        Qa = 0;
        var K = Bt(
          m,
          d,
          h,
          A
        );
        return la = null, K;
      } catch (X) {
        if (X === ea || X === Ju) throw X;
        var Tt = Ze(29, X, null, m.mode);
        return Tt.lanes = A, Tt.return = m, Tt;
      } finally {
      }
    };
  }
  var zn = $s(!0), Ws = $s(!1), Kl = !1;
  function Oc(t) {
    t.updateQueue = {
      baseState: t.memoizedState,
      firstBaseUpdate: null,
      lastBaseUpdate: null,
      shared: { pending: null, lanes: 0, hiddenCallbacks: null },
      callbacks: null
    };
  }
  function Nc(t, e) {
    t = t.updateQueue, e.updateQueue === t && (e.updateQueue = {
      baseState: t.baseState,
      firstBaseUpdate: t.firstBaseUpdate,
      lastBaseUpdate: t.lastBaseUpdate,
      shared: t.shared,
      callbacks: null
    });
  }
  function Vl(t) {
    return { lane: t, tag: 0, payload: null, callback: null, next: null };
  }
  function kl(t, e, l) {
    var n = t.updateQueue;
    if (n === null) return null;
    if (n = n.shared, Ot & 2) {
      var a = n.pending;
      return a === null ? e.next = e : (e.next = a.next, a.next = e), n.pending = e, e = Zu(t), xs(t, null, l), e;
    }
    return Xu(t, n, e, l), Zu(t);
  }
  function Va(t, e, l) {
    if (e = e.updateQueue, e !== null && (e = e.shared, (l & 4194048) !== 0)) {
      var n = e.lanes;
      n &= t.pendingLanes, l |= n, e.lanes = l, W(t, l);
    }
  }
  function Mc(t, e) {
    var l = t.updateQueue, n = t.alternate;
    if (n !== null && (n = n.updateQueue, l === n)) {
      var a = null, u = null;
      if (l = l.firstBaseUpdate, l !== null) {
        do {
          var i = {
            lane: l.lane,
            tag: l.tag,
            payload: l.payload,
            callback: null,
            next: null
          };
          u === null ? a = u = i : u = u.next = i, l = l.next;
        } while (l !== null);
        u === null ? a = u = e : u = u.next = e;
      } else a = u = e;
      l = {
        baseState: n.baseState,
        firstBaseUpdate: a,
        lastBaseUpdate: u,
        shared: n.shared,
        callbacks: n.callbacks
      }, t.updateQueue = l;
      return;
    }
    t = l.lastBaseUpdate, t === null ? l.firstBaseUpdate = e : t.next = e, l.lastBaseUpdate = e;
  }
  var Rc = !1;
  function ka() {
    if (Rc) {
      var t = ta;
      if (t !== null) throw t;
    }
  }
  function Ja(t, e, l, n) {
    Rc = !1;
    var a = t.updateQueue;
    Kl = !1;
    var u = a.firstBaseUpdate, i = a.lastBaseUpdate, c = a.shared.pending;
    if (c !== null) {
      a.shared.pending = null;
      var f = c, b = f.next;
      f.next = null, i === null ? u = b : i.next = b, i = f;
      var S = t.alternate;
      S !== null && (S = S.updateQueue, c = S.lastBaseUpdate, c !== i && (c === null ? S.firstBaseUpdate = b : c.next = b, S.lastBaseUpdate = f));
    }
    if (u !== null) {
      var O = a.baseState;
      i = 0, S = b = f = null, c = u;
      do {
        var y = c.lane & -536870913, v = y !== c.lane;
        if (v ? (yt & y) === y : (n & y) === y) {
          y !== 0 && y === Pn && (Rc = !0), S !== null && (S = S.next = {
            lane: 0,
            tag: c.tag,
            payload: c.payload,
            callback: null,
            next: null
          });
          t: {
            var G = t, k = c;
            y = e;
            var Bt = l;
            switch (k.tag) {
              case 1:
                if (G = k.payload, typeof G == "function") {
                  O = G.call(Bt, O, y);
                  break t;
                }
                O = G;
                break t;
              case 3:
                G.flags = G.flags & -65537 | 128;
              case 0:
                if (G = k.payload, y = typeof G == "function" ? G.call(Bt, O, y) : G, y == null) break t;
                O = H({}, O, y);
                break t;
              case 2:
                Kl = !0;
            }
          }
          y = c.callback, y !== null && (t.flags |= 64, v && (t.flags |= 8192), v = a.callbacks, v === null ? a.callbacks = [y] : v.push(y));
        } else
          v = {
            lane: y,
            tag: c.tag,
            payload: c.payload,
            callback: c.callback,
            next: null
          }, S === null ? (b = S = v, f = O) : S = S.next = v, i |= y;
        if (c = c.next, c === null) {
          if (c = a.shared.pending, c === null)
            break;
          v = c, c = v.next, v.next = null, a.lastBaseUpdate = v, a.shared.pending = null;
        }
      } while (!0);
      S === null && (f = O), a.baseState = f, a.firstBaseUpdate = b, a.lastBaseUpdate = S, u === null && (a.shared.lanes = 0), Fl |= i, t.lanes = i, t.memoizedState = O;
    }
  }
  function Is(t, e) {
    if (typeof t != "function")
      throw Error(r(191, t));
    t.call(e);
  }
  function Fs(t, e) {
    var l = t.callbacks;
    if (l !== null)
      for (t.callbacks = null, t = 0; t < l.length; t++)
        Is(l[t], e);
  }
  var na = o(null), Fu = o(0);
  function Ps(t, e) {
    t = Ul, C(Fu, t), C(na, e), Ul = t | e.baseLanes;
  }
  function zc() {
    C(Fu, Ul), C(na, na.current);
  }
  function Dc() {
    Ul = Fu.current, _(na), _(Fu);
  }
  var je = o(null), tl = null;
  function Jl(t) {
    var e = t.alternate;
    C(ee, ee.current & 1), C(je, t), tl === null && (e === null || na.current !== null || e.memoizedState !== null) && (tl = t);
  }
  function Cc(t) {
    C(ee, ee.current), C(je, t), tl === null && (tl = t);
  }
  function to(t) {
    t.tag === 22 ? (C(ee, ee.current), C(je, t), tl === null && (tl = t)) : $l();
  }
  function $l() {
    C(ee, ee.current), C(je, je.current);
  }
  function Qe(t) {
    _(je), tl === t && (tl = null), _(ee);
  }
  var ee = o(0);
  function Pu(t) {
    for (var e = t; e !== null; ) {
      if (e.tag === 13) {
        var l = e.memoizedState;
        if (l !== null && (l = l.dehydrated, l === null || qf(l) || Yf(l)))
          return e;
      } else if (e.tag === 19 && (e.memoizedProps.revealOrder === "forwards" || e.memoizedProps.revealOrder === "backwards" || e.memoizedProps.revealOrder === "unstable_legacy-backwards" || e.memoizedProps.revealOrder === "together")) {
        if (e.flags & 128) return e;
      } else if (e.child !== null) {
        e.child.return = e, e = e.child;
        continue;
      }
      if (e === t) break;
      for (; e.sibling === null; ) {
        if (e.return === null || e.return === t) return null;
        e = e.return;
      }
      e.sibling.return = e.return, e = e.sibling;
    }
    return null;
  }
  var Al = 0, ct = null, Ut = null, ce = null, ti = !1, aa = !1, Dn = !1, ei = 0, $a = 0, ua = null, Ig = 0;
  function $t() {
    throw Error(r(321));
  }
  function Uc(t, e) {
    if (e === null) return !1;
    for (var l = 0; l < e.length && l < t.length; l++)
      if (!Xe(t[l], e[l])) return !1;
    return !0;
  }
  function xc(t, e, l, n, a, u) {
    return Al = u, ct = e, e.memoizedState = null, e.updateQueue = null, e.lanes = 0, p.H = t === null || t.memoizedState === null ? qo : Jc, Dn = !1, u = l(n, a), Dn = !1, aa && (u = lo(
      e,
      l,
      n,
      a
    )), eo(t), u;
  }
  function eo(t) {
    p.H = Fa;
    var e = Ut !== null && Ut.next !== null;
    if (Al = 0, ce = Ut = ct = null, ti = !1, $a = 0, ua = null, e) throw Error(r(300));
    t === null || fe || (t = t.dependencies, t !== null && Ku(t) && (fe = !0));
  }
  function lo(t, e, l, n) {
    ct = t;
    var a = 0;
    do {
      if (aa && (ua = null), $a = 0, aa = !1, 25 <= a) throw Error(r(301));
      if (a += 1, ce = Ut = null, t.updateQueue != null) {
        var u = t.updateQueue;
        u.lastEffect = null, u.events = null, u.stores = null, u.memoCache != null && (u.memoCache.index = 0);
      }
      p.H = Yo, u = e(l, n);
    } while (aa);
    return u;
  }
  function Fg() {
    var t = p.H, e = t.useState()[0];
    return e = typeof e.then == "function" ? Wa(e) : e, t = t.useState()[0], (Ut !== null ? Ut.memoizedState : null) !== t && (ct.flags |= 1024), e;
  }
  function Bc() {
    var t = ei !== 0;
    return ei = 0, t;
  }
  function Hc(t, e, l) {
    e.updateQueue = t.updateQueue, e.flags &= -2053, t.lanes &= ~l;
  }
  function Lc(t) {
    if (ti) {
      for (t = t.memoizedState; t !== null; ) {
        var e = t.queue;
        e !== null && (e.pending = null), t = t.next;
      }
      ti = !1;
    }
    Al = 0, ce = Ut = ct = null, aa = !1, $a = ei = 0, ua = null;
  }
  function Me() {
    var t = {
      memoizedState: null,
      baseState: null,
      baseQueue: null,
      queue: null,
      next: null
    };
    return ce === null ? ct.memoizedState = ce = t : ce = ce.next = t, ce;
  }
  function le() {
    if (Ut === null) {
      var t = ct.alternate;
      t = t !== null ? t.memoizedState : null;
    } else t = Ut.next;
    var e = ce === null ? ct.memoizedState : ce.next;
    if (e !== null)
      ce = e, Ut = t;
    else {
      if (t === null)
        throw ct.alternate === null ? Error(r(467)) : Error(r(310));
      Ut = t, t = {
        memoizedState: Ut.memoizedState,
        baseState: Ut.baseState,
        baseQueue: Ut.baseQueue,
        queue: Ut.queue,
        next: null
      }, ce === null ? ct.memoizedState = ce = t : ce = ce.next = t;
    }
    return ce;
  }
  function li() {
    return { lastEffect: null, events: null, stores: null, memoCache: null };
  }
  function Wa(t) {
    var e = $a;
    return $a += 1, ua === null && (ua = []), t = Vs(ua, t, e), e = ct, (ce === null ? e.memoizedState : ce.next) === null && (e = e.alternate, p.H = e === null || e.memoizedState === null ? qo : Jc), t;
  }
  function ni(t) {
    if (t !== null && typeof t == "object") {
      if (typeof t.then == "function") return Wa(t);
      if (t.$$typeof === Nt) return ve(t);
    }
    throw Error(r(438, String(t)));
  }
  function Gc(t) {
    var e = null, l = ct.updateQueue;
    if (l !== null && (e = l.memoCache), e == null) {
      var n = ct.alternate;
      n !== null && (n = n.updateQueue, n !== null && (n = n.memoCache, n != null && (e = {
        data: n.data.map(function(a) {
          return a.slice();
        }),
        index: 0
      })));
    }
    if (e == null && (e = { data: [], index: 0 }), l === null && (l = li(), ct.updateQueue = l), l.memoCache = e, l = e.data[e.index], l === void 0)
      for (l = e.data[e.index] = Array(t), n = 0; n < t; n++)
        l[n] = Ge;
    return e.index++, l;
  }
  function Ol(t, e) {
    return typeof e == "function" ? e(t) : e;
  }
  function ai(t) {
    var e = le();
    return qc(e, Ut, t);
  }
  function qc(t, e, l) {
    var n = t.queue;
    if (n === null) throw Error(r(311));
    n.lastRenderedReducer = l;
    var a = t.baseQueue, u = n.pending;
    if (u !== null) {
      if (a !== null) {
        var i = a.next;
        a.next = u.next, u.next = i;
      }
      e.baseQueue = a = u, n.pending = null;
    }
    if (u = t.baseState, a === null) t.memoizedState = u;
    else {
      e = a.next;
      var c = i = null, f = null, b = e, S = !1;
      do {
        var O = b.lane & -536870913;
        if (O !== b.lane ? (yt & O) === O : (Al & O) === O) {
          var y = b.revertLane;
          if (y === 0)
            f !== null && (f = f.next = {
              lane: 0,
              revertLane: 0,
              gesture: null,
              action: b.action,
              hasEagerState: b.hasEagerState,
              eagerState: b.eagerState,
              next: null
            }), O === Pn && (S = !0);
          else if ((Al & y) === y) {
            b = b.next, y === Pn && (S = !0);
            continue;
          } else
            O = {
              lane: 0,
              revertLane: b.revertLane,
              gesture: null,
              action: b.action,
              hasEagerState: b.hasEagerState,
              eagerState: b.eagerState,
              next: null
            }, f === null ? (c = f = O, i = u) : f = f.next = O, ct.lanes |= y, Fl |= y;
          O = b.action, Dn && l(u, O), u = b.hasEagerState ? b.eagerState : l(u, O);
        } else
          y = {
            lane: O,
            revertLane: b.revertLane,
            gesture: b.gesture,
            action: b.action,
            hasEagerState: b.hasEagerState,
            eagerState: b.eagerState,
            next: null
          }, f === null ? (c = f = y, i = u) : f = f.next = y, ct.lanes |= O, Fl |= O;
        b = b.next;
      } while (b !== null && b !== e);
      if (f === null ? i = u : f.next = c, !Xe(u, t.memoizedState) && (fe = !0, S && (l = ta, l !== null)))
        throw l;
      t.memoizedState = u, t.baseState = i, t.baseQueue = f, n.lastRenderedState = u;
    }
    return a === null && (n.lanes = 0), [t.memoizedState, n.dispatch];
  }
  function Yc(t) {
    var e = le(), l = e.queue;
    if (l === null) throw Error(r(311));
    l.lastRenderedReducer = t;
    var n = l.dispatch, a = l.pending, u = e.memoizedState;
    if (a !== null) {
      l.pending = null;
      var i = a = a.next;
      do
        u = t(u, i.action), i = i.next;
      while (i !== a);
      Xe(u, e.memoizedState) || (fe = !0), e.memoizedState = u, e.baseQueue === null && (e.baseState = u), l.lastRenderedState = u;
    }
    return [u, n];
  }
  function no(t, e, l) {
    var n = ct, a = le(), u = Et;
    if (u) {
      if (l === void 0) throw Error(r(407));
      l = l();
    } else l = e();
    var i = !Xe(
      (Ut || a).memoizedState,
      l
    );
    if (i && (a.memoizedState = l, fe = !0), a = a.queue, Zc(io.bind(null, n, a, t), [
      t
    ]), a.getSnapshot !== e || i || ce !== null && ce.memoizedState.tag & 1) {
      if (n.flags |= 2048, ia(
        9,
        { destroy: void 0 },
        uo.bind(
          null,
          n,
          a,
          l,
          e
        ),
        null
      ), Gt === null) throw Error(r(349));
      u || Al & 127 || ao(n, e, l);
    }
    return l;
  }
  function ao(t, e, l) {
    t.flags |= 16384, t = { getSnapshot: e, value: l }, e = ct.updateQueue, e === null ? (e = li(), ct.updateQueue = e, e.stores = [t]) : (l = e.stores, l === null ? e.stores = [t] : l.push(t));
  }
  function uo(t, e, l, n) {
    e.value = l, e.getSnapshot = n, co(e) && fo(t);
  }
  function io(t, e, l) {
    return l(function() {
      co(e) && fo(t);
    });
  }
  function co(t) {
    var e = t.getSnapshot;
    t = t.value;
    try {
      var l = e();
      return !Xe(t, l);
    } catch {
      return !0;
    }
  }
  function fo(t) {
    var e = Sn(t, 2);
    e !== null && Le(e, t, 2);
  }
  function wc(t) {
    var e = Me();
    if (typeof t == "function") {
      var l = t;
      if (t = l(), Dn) {
        cl(!0);
        try {
          l();
        } finally {
          cl(!1);
        }
      }
    }
    return e.memoizedState = e.baseState = t, e.queue = {
      pending: null,
      lanes: 0,
      dispatch: null,
      lastRenderedReducer: Ol,
      lastRenderedState: t
    }, e;
  }
  function so(t, e, l, n) {
    return t.baseState = l, qc(
      t,
      Ut,
      typeof n == "function" ? n : Ol
    );
  }
  function Pg(t, e, l, n, a) {
    if (ci(t)) throw Error(r(485));
    if (t = e.action, t !== null) {
      var u = {
        payload: a,
        action: t,
        next: null,
        isTransition: !0,
        status: "pending",
        value: null,
        reason: null,
        listeners: [],
        then: function(i) {
          u.listeners.push(i);
        }
      };
      p.T !== null ? l(!0) : u.isTransition = !1, n(u), l = e.pending, l === null ? (u.next = e.pending = u, oo(e, u)) : (u.next = l.next, e.pending = l.next = u);
    }
  }
  function oo(t, e) {
    var l = e.action, n = e.payload, a = t.state;
    if (e.isTransition) {
      var u = p.T, i = {};
      p.T = i;
      try {
        var c = l(a, n), f = p.S;
        f !== null && f(i, c), ro(t, e, c);
      } catch (b) {
        Xc(t, e, b);
      } finally {
        u !== null && i.types !== null && (u.types = i.types), p.T = u;
      }
    } else
      try {
        u = l(a, n), ro(t, e, u);
      } catch (b) {
        Xc(t, e, b);
      }
  }
  function ro(t, e, l) {
    l !== null && typeof l == "object" && typeof l.then == "function" ? l.then(
      function(n) {
        go(t, e, n);
      },
      function(n) {
        return Xc(t, e, n);
      }
    ) : go(t, e, l);
  }
  function go(t, e, l) {
    e.status = "fulfilled", e.value = l, mo(e), t.state = l, e = t.pending, e !== null && (l = e.next, l === e ? t.pending = null : (l = l.next, e.next = l, oo(t, l)));
  }
  function Xc(t, e, l) {
    var n = t.pending;
    if (t.pending = null, n !== null) {
      n = n.next;
      do
        e.status = "rejected", e.reason = l, mo(e), e = e.next;
      while (e !== n);
    }
    t.action = null;
  }
  function mo(t) {
    t = t.listeners;
    for (var e = 0; e < t.length; e++) (0, t[e])();
  }
  function ho(t, e) {
    return e;
  }
  function bo(t, e) {
    if (Et) {
      var l = Gt.formState;
      if (l !== null) {
        t: {
          var n = ct;
          if (Et) {
            if (Xt) {
              e: {
                for (var a = Xt, u = Pe; a.nodeType !== 8; ) {
                  if (!u) {
                    a = null;
                    break e;
                  }
                  if (a = el(
                    a.nextSibling
                  ), a === null) {
                    a = null;
                    break e;
                  }
                }
                u = a.data, a = u === "F!" || u === "F" ? a : null;
              }
              if (a) {
                Xt = el(
                  a.nextSibling
                ), n = a.data === "F!";
                break t;
              }
            }
            jl(n);
          }
          n = !1;
        }
        n && (e = l[0]);
      }
    }
    return l = Me(), l.memoizedState = l.baseState = e, n = {
      pending: null,
      lanes: 0,
      dispatch: null,
      lastRenderedReducer: ho,
      lastRenderedState: e
    }, l.queue = n, l = Ho.bind(
      null,
      ct,
      n
    ), n.dispatch = l, n = wc(!1), u = kc.bind(
      null,
      ct,
      !1,
      n.queue
    ), n = Me(), a = {
      state: e,
      dispatch: null,
      action: t,
      pending: null
    }, n.queue = a, l = Pg.bind(
      null,
      ct,
      a,
      u,
      l
    ), a.dispatch = l, n.memoizedState = t, [e, l, !1];
  }
  function yo(t) {
    var e = le();
    return vo(e, Ut, t);
  }
  function vo(t, e, l) {
    if (e = qc(
      t,
      e,
      ho
    )[0], t = ai(Ol)[0], typeof e == "object" && e !== null && typeof e.then == "function")
      try {
        var n = Wa(e);
      } catch (i) {
        throw i === ea ? Ju : i;
      }
    else n = e;
    e = le();
    var a = e.queue, u = a.dispatch;
    return l !== e.memoizedState && (ct.flags |= 2048, ia(
      9,
      { destroy: void 0 },
      tm.bind(null, a, l),
      null
    )), [n, u, t];
  }
  function tm(t, e) {
    t.action = e;
  }
  function Eo(t) {
    var e = le(), l = Ut;
    if (l !== null)
      return vo(e, l, t);
    le(), e = e.memoizedState, l = le();
    var n = l.queue.dispatch;
    return l.memoizedState = t, [e, n, !1];
  }
  function ia(t, e, l, n) {
    return t = { tag: t, create: l, deps: n, inst: e, next: null }, e = ct.updateQueue, e === null && (e = li(), ct.updateQueue = e), l = e.lastEffect, l === null ? e.lastEffect = t.next = t : (n = l.next, l.next = t, t.next = n, e.lastEffect = t), t;
  }
  function po() {
    return le().memoizedState;
  }
  function ui(t, e, l, n) {
    var a = Me();
    ct.flags |= t, a.memoizedState = ia(
      1 | e,
      { destroy: void 0 },
      l,
      n === void 0 ? null : n
    );
  }
  function ii(t, e, l, n) {
    var a = le();
    n = n === void 0 ? null : n;
    var u = a.memoizedState.inst;
    Ut !== null && n !== null && Uc(n, Ut.memoizedState.deps) ? a.memoizedState = ia(e, u, l, n) : (ct.flags |= t, a.memoizedState = ia(
      1 | e,
      u,
      l,
      n
    ));
  }
  function So(t, e) {
    ui(8390656, 8, t, e);
  }
  function Zc(t, e) {
    ii(2048, 8, t, e);
  }
  function em(t) {
    ct.flags |= 4;
    var e = ct.updateQueue;
    if (e === null)
      e = li(), ct.updateQueue = e, e.events = [t];
    else {
      var l = e.events;
      l === null ? e.events = [t] : l.push(t);
    }
  }
  function _o(t) {
    var e = le().memoizedState;
    return em({ ref: e, nextImpl: t }), function() {
      if (Ot & 2) throw Error(r(440));
      return e.impl.apply(void 0, arguments);
    };
  }
  function To(t, e) {
    return ii(4, 2, t, e);
  }
  function Ao(t, e) {
    return ii(4, 4, t, e);
  }
  function Oo(t, e) {
    if (typeof e == "function") {
      t = t();
      var l = e(t);
      return function() {
        typeof l == "function" ? l() : e(null);
      };
    }
    if (e != null)
      return t = t(), e.current = t, function() {
        e.current = null;
      };
  }
  function No(t, e, l) {
    l = l != null ? l.concat([t]) : null, ii(4, 4, Oo.bind(null, e, t), l);
  }
  function jc() {
  }
  function Mo(t, e) {
    var l = le();
    e = e === void 0 ? null : e;
    var n = l.memoizedState;
    return e !== null && Uc(e, n[1]) ? n[0] : (l.memoizedState = [t, e], t);
  }
  function Ro(t, e) {
    var l = le();
    e = e === void 0 ? null : e;
    var n = l.memoizedState;
    if (e !== null && Uc(e, n[1]))
      return n[0];
    if (n = t(), Dn) {
      cl(!0);
      try {
        t();
      } finally {
        cl(!1);
      }
    }
    return l.memoizedState = [n, e], n;
  }
  function Qc(t, e, l) {
    return l === void 0 || Al & 1073741824 && !(yt & 261930) ? t.memoizedState = e : (t.memoizedState = l, t = zr(), ct.lanes |= t, Fl |= t, l);
  }
  function zo(t, e, l, n) {
    return Xe(l, e) ? l : na.current !== null ? (t = Qc(t, l, n), Xe(t, e) || (fe = !0), t) : !(Al & 42) || Al & 1073741824 && !(yt & 261930) ? (fe = !0, t.memoizedState = l) : (t = zr(), ct.lanes |= t, Fl |= t, e);
  }
  function Do(t, e, l, n, a) {
    var u = U.p;
    U.p = u !== 0 && 8 > u ? u : 8;
    var i = p.T, c = {};
    p.T = c, kc(t, !1, e, l);
    try {
      var f = a(), b = p.S;
      if (b !== null && b(c, f), f !== null && typeof f == "object" && typeof f.then == "function") {
        var S = Wg(
          f,
          n
        );
        Ia(
          t,
          e,
          S,
          ke(t)
        );
      } else
        Ia(
          t,
          e,
          n,
          ke(t)
        );
    } catch (O) {
      Ia(
        t,
        e,
        { then: function() {
        }, status: "rejected", reason: O },
        ke()
      );
    } finally {
      U.p = u, i !== null && c.types !== null && (i.types = c.types), p.T = i;
    }
  }
  function lm() {
  }
  function Kc(t, e, l, n) {
    if (t.tag !== 5) throw Error(r(476));
    var a = Co(t).queue;
    Do(
      t,
      a,
      e,
      x,
      l === null ? lm : function() {
        return Uo(t), l(n);
      }
    );
  }
  function Co(t) {
    var e = t.memoizedState;
    if (e !== null) return e;
    e = {
      memoizedState: x,
      baseState: x,
      baseQueue: null,
      queue: {
        pending: null,
        lanes: 0,
        dispatch: null,
        lastRenderedReducer: Ol,
        lastRenderedState: x
      },
      next: null
    };
    var l = {};
    return e.next = {
      memoizedState: l,
      baseState: l,
      baseQueue: null,
      queue: {
        pending: null,
        lanes: 0,
        dispatch: null,
        lastRenderedReducer: Ol,
        lastRenderedState: l
      },
      next: null
    }, t.memoizedState = e, t = t.alternate, t !== null && (t.memoizedState = e), e;
  }
  function Uo(t) {
    var e = Co(t);
    e.next === null && (e = t.alternate.memoizedState), Ia(
      t,
      e.next.queue,
      {},
      ke()
    );
  }
  function Vc() {
    return ve(mu);
  }
  function xo() {
    return le().memoizedState;
  }
  function Bo() {
    return le().memoizedState;
  }
  function nm(t) {
    for (var e = t.return; e !== null; ) {
      switch (e.tag) {
        case 24:
        case 3:
          var l = ke();
          t = Vl(l);
          var n = kl(e, t, l);
          n !== null && (Le(n, e, l), Va(n, e, l)), e = { cache: Sc() }, t.payload = e;
          return;
      }
      e = e.return;
    }
  }
  function am(t, e, l) {
    var n = ke();
    l = {
      lane: n,
      revertLane: 0,
      gesture: null,
      action: l,
      hasEagerState: !1,
      eagerState: null,
      next: null
    }, ci(t) ? Lo(e, l) : (l = oc(t, e, l, n), l !== null && (Le(l, t, n), Go(l, e, n)));
  }
  function Ho(t, e, l) {
    var n = ke();
    Ia(t, e, l, n);
  }
  function Ia(t, e, l, n) {
    var a = {
      lane: n,
      revertLane: 0,
      gesture: null,
      action: l,
      hasEagerState: !1,
      eagerState: null,
      next: null
    };
    if (ci(t)) Lo(e, a);
    else {
      var u = t.alternate;
      if (t.lanes === 0 && (u === null || u.lanes === 0) && (u = e.lastRenderedReducer, u !== null))
        try {
          var i = e.lastRenderedState, c = u(i, l);
          if (a.hasEagerState = !0, a.eagerState = c, Xe(c, i))
            return Xu(t, e, a, 0), Gt === null && wu(), !1;
        } catch {
        } finally {
        }
      if (l = oc(t, e, a, n), l !== null)
        return Le(l, t, n), Go(l, e, n), !0;
    }
    return !1;
  }
  function kc(t, e, l, n) {
    if (n = {
      lane: 2,
      revertLane: Nf(),
      gesture: null,
      action: n,
      hasEagerState: !1,
      eagerState: null,
      next: null
    }, ci(t)) {
      if (e) throw Error(r(479));
    } else
      e = oc(
        t,
        l,
        n,
        2
      ), e !== null && Le(e, t, 2);
  }
  function ci(t) {
    var e = t.alternate;
    return t === ct || e !== null && e === ct;
  }
  function Lo(t, e) {
    aa = ti = !0;
    var l = t.pending;
    l === null ? e.next = e : (e.next = l.next, l.next = e), t.pending = e;
  }
  function Go(t, e, l) {
    if (l & 4194048) {
      var n = e.lanes;
      n &= t.pendingLanes, l |= n, e.lanes = l, W(t, l);
    }
  }
  var Fa = {
    readContext: ve,
    use: ni,
    useCallback: $t,
    useContext: $t,
    useEffect: $t,
    useImperativeHandle: $t,
    useLayoutEffect: $t,
    useInsertionEffect: $t,
    useMemo: $t,
    useReducer: $t,
    useRef: $t,
    useState: $t,
    useDebugValue: $t,
    useDeferredValue: $t,
    useTransition: $t,
    useSyncExternalStore: $t,
    useId: $t,
    useHostTransitionStatus: $t,
    useFormState: $t,
    useActionState: $t,
    useOptimistic: $t,
    useMemoCache: $t,
    useCacheRefresh: $t
  };
  Fa.useEffectEvent = $t;
  var qo = {
    readContext: ve,
    use: ni,
    useCallback: function(t, e) {
      return Me().memoizedState = [
        t,
        e === void 0 ? null : e
      ], t;
    },
    useContext: ve,
    useEffect: So,
    useImperativeHandle: function(t, e, l) {
      l = l != null ? l.concat([t]) : null, ui(
        4194308,
        4,
        Oo.bind(null, e, t),
        l
      );
    },
    useLayoutEffect: function(t, e) {
      return ui(4194308, 4, t, e);
    },
    useInsertionEffect: function(t, e) {
      ui(4, 2, t, e);
    },
    useMemo: function(t, e) {
      var l = Me();
      e = e === void 0 ? null : e;
      var n = t();
      if (Dn) {
        cl(!0);
        try {
          t();
        } finally {
          cl(!1);
        }
      }
      return l.memoizedState = [n, e], n;
    },
    useReducer: function(t, e, l) {
      var n = Me();
      if (l !== void 0) {
        var a = l(e);
        if (Dn) {
          cl(!0);
          try {
            l(e);
          } finally {
            cl(!1);
          }
        }
      } else a = e;
      return n.memoizedState = n.baseState = a, t = {
        pending: null,
        lanes: 0,
        dispatch: null,
        lastRenderedReducer: t,
        lastRenderedState: a
      }, n.queue = t, t = t.dispatch = am.bind(
        null,
        ct,
        t
      ), [n.memoizedState, t];
    },
    useRef: function(t) {
      var e = Me();
      return t = { current: t }, e.memoizedState = t;
    },
    useState: function(t) {
      t = wc(t);
      var e = t.queue, l = Ho.bind(null, ct, e);
      return e.dispatch = l, [t.memoizedState, l];
    },
    useDebugValue: jc,
    useDeferredValue: function(t, e) {
      var l = Me();
      return Qc(l, t, e);
    },
    useTransition: function() {
      var t = wc(!1);
      return t = Do.bind(
        null,
        ct,
        t.queue,
        !0,
        !1
      ), Me().memoizedState = t, [!1, t];
    },
    useSyncExternalStore: function(t, e, l) {
      var n = ct, a = Me();
      if (Et) {
        if (l === void 0)
          throw Error(r(407));
        l = l();
      } else {
        if (l = e(), Gt === null)
          throw Error(r(349));
        yt & 127 || ao(n, e, l);
      }
      a.memoizedState = l;
      var u = { value: l, getSnapshot: e };
      return a.queue = u, So(io.bind(null, n, u, t), [
        t
      ]), n.flags |= 2048, ia(
        9,
        { destroy: void 0 },
        uo.bind(
          null,
          n,
          u,
          l,
          e
        ),
        null
      ), l;
    },
    useId: function() {
      var t = Me(), e = Gt.identifierPrefix;
      if (Et) {
        var l = ol, n = sl;
        l = (n & ~(1 << 32 - Oe(n) - 1)).toString(32) + l, e = "_" + e + "R_" + l, l = ei++, 0 < l && (e += "H" + l.toString(32)), e += "_";
      } else
        l = Ig++, e = "_" + e + "r_" + l.toString(32) + "_";
      return t.memoizedState = e;
    },
    useHostTransitionStatus: Vc,
    useFormState: bo,
    useActionState: bo,
    useOptimistic: function(t) {
      var e = Me();
      e.memoizedState = e.baseState = t;
      var l = {
        pending: null,
        lanes: 0,
        dispatch: null,
        lastRenderedReducer: null,
        lastRenderedState: null
      };
      return e.queue = l, e = kc.bind(
        null,
        ct,
        !0,
        l
      ), l.dispatch = e, [t, e];
    },
    useMemoCache: Gc,
    useCacheRefresh: function() {
      return Me().memoizedState = nm.bind(
        null,
        ct
      );
    },
    useEffectEvent: function(t) {
      var e = Me(), l = { impl: t };
      return e.memoizedState = l, function() {
        if (Ot & 2)
          throw Error(r(440));
        return l.impl.apply(void 0, arguments);
      };
    }
  }, Jc = {
    readContext: ve,
    use: ni,
    useCallback: Mo,
    useContext: ve,
    useEffect: Zc,
    useImperativeHandle: No,
    useInsertionEffect: To,
    useLayoutEffect: Ao,
    useMemo: Ro,
    useReducer: ai,
    useRef: po,
    useState: function() {
      return ai(Ol);
    },
    useDebugValue: jc,
    useDeferredValue: function(t, e) {
      var l = le();
      return zo(
        l,
        Ut.memoizedState,
        t,
        e
      );
    },
    useTransition: function() {
      var t = ai(Ol)[0], e = le().memoizedState;
      return [
        typeof t == "boolean" ? t : Wa(t),
        e
      ];
    },
    useSyncExternalStore: no,
    useId: xo,
    useHostTransitionStatus: Vc,
    useFormState: yo,
    useActionState: yo,
    useOptimistic: function(t, e) {
      var l = le();
      return so(l, Ut, t, e);
    },
    useMemoCache: Gc,
    useCacheRefresh: Bo
  };
  Jc.useEffectEvent = _o;
  var Yo = {
    readContext: ve,
    use: ni,
    useCallback: Mo,
    useContext: ve,
    useEffect: Zc,
    useImperativeHandle: No,
    useInsertionEffect: To,
    useLayoutEffect: Ao,
    useMemo: Ro,
    useReducer: Yc,
    useRef: po,
    useState: function() {
      return Yc(Ol);
    },
    useDebugValue: jc,
    useDeferredValue: function(t, e) {
      var l = le();
      return Ut === null ? Qc(l, t, e) : zo(
        l,
        Ut.memoizedState,
        t,
        e
      );
    },
    useTransition: function() {
      var t = Yc(Ol)[0], e = le().memoizedState;
      return [
        typeof t == "boolean" ? t : Wa(t),
        e
      ];
    },
    useSyncExternalStore: no,
    useId: xo,
    useHostTransitionStatus: Vc,
    useFormState: Eo,
    useActionState: Eo,
    useOptimistic: function(t, e) {
      var l = le();
      return Ut !== null ? so(l, Ut, t, e) : (l.baseState = t, [t, l.queue.dispatch]);
    },
    useMemoCache: Gc,
    useCacheRefresh: Bo
  };
  Yo.useEffectEvent = _o;
  function $c(t, e, l, n) {
    e = t.memoizedState, l = l(n, e), l = l == null ? e : H({}, e, l), t.memoizedState = l, t.lanes === 0 && (t.updateQueue.baseState = l);
  }
  var Wc = {
    enqueueSetState: function(t, e, l) {
      t = t._reactInternals;
      var n = ke(), a = Vl(n);
      a.payload = e, l != null && (a.callback = l), e = kl(t, a, n), e !== null && (Le(e, t, n), Va(e, t, n));
    },
    enqueueReplaceState: function(t, e, l) {
      t = t._reactInternals;
      var n = ke(), a = Vl(n);
      a.tag = 1, a.payload = e, l != null && (a.callback = l), e = kl(t, a, n), e !== null && (Le(e, t, n), Va(e, t, n));
    },
    enqueueForceUpdate: function(t, e) {
      t = t._reactInternals;
      var l = ke(), n = Vl(l);
      n.tag = 2, e != null && (n.callback = e), e = kl(t, n, l), e !== null && (Le(e, t, l), Va(e, t, l));
    }
  };
  function wo(t, e, l, n, a, u, i) {
    return t = t.stateNode, typeof t.shouldComponentUpdate == "function" ? t.shouldComponentUpdate(n, u, i) : e.prototype && e.prototype.isPureReactComponent ? !qa(l, n) || !qa(a, u) : !0;
  }
  function Xo(t, e, l, n) {
    t = e.state, typeof e.componentWillReceiveProps == "function" && e.componentWillReceiveProps(l, n), typeof e.UNSAFE_componentWillReceiveProps == "function" && e.UNSAFE_componentWillReceiveProps(l, n), e.state !== t && Wc.enqueueReplaceState(e, e.state, null);
  }
  function Cn(t, e) {
    var l = e;
    if ("ref" in e) {
      l = {};
      for (var n in e)
        n !== "ref" && (l[n] = e[n]);
    }
    if (t = t.defaultProps) {
      l === e && (l = H({}, l));
      for (var a in t)
        l[a] === void 0 && (l[a] = t[a]);
    }
    return l;
  }
  function Zo(t) {
    Yu(t);
  }
  function jo(t) {
    console.error(t);
  }
  function Qo(t) {
    Yu(t);
  }
  function fi(t, e) {
    try {
      var l = t.onUncaughtError;
      l(e.value, { componentStack: e.stack });
    } catch (n) {
      setTimeout(function() {
        throw n;
      });
    }
  }
  function Ko(t, e, l) {
    try {
      var n = t.onCaughtError;
      n(l.value, {
        componentStack: l.stack,
        errorBoundary: e.tag === 1 ? e.stateNode : null
      });
    } catch (a) {
      setTimeout(function() {
        throw a;
      });
    }
  }
  function Ic(t, e, l) {
    return l = Vl(l), l.tag = 3, l.payload = { element: null }, l.callback = function() {
      fi(t, e);
    }, l;
  }
  function Vo(t) {
    return t = Vl(t), t.tag = 3, t;
  }
  function ko(t, e, l, n) {
    var a = l.type.getDerivedStateFromError;
    if (typeof a == "function") {
      var u = n.value;
      t.payload = function() {
        return a(u);
      }, t.callback = function() {
        Ko(e, l, n);
      };
    }
    var i = l.stateNode;
    i !== null && typeof i.componentDidCatch == "function" && (t.callback = function() {
      Ko(e, l, n), typeof a != "function" && (Pl === null ? Pl = /* @__PURE__ */ new Set([this]) : Pl.add(this));
      var c = n.stack;
      this.componentDidCatch(n.value, {
        componentStack: c !== null ? c : ""
      });
    });
  }
  function um(t, e, l, n, a) {
    if (l.flags |= 32768, n !== null && typeof n == "object" && typeof n.then == "function") {
      if (e = l.alternate, e !== null && Fn(
        e,
        l,
        a,
        !0
      ), l = je.current, l !== null) {
        switch (l.tag) {
          case 31:
          case 13:
            return tl === null ? pi() : l.alternate === null && Wt === 0 && (Wt = 3), l.flags &= -257, l.flags |= 65536, l.lanes = a, n === $u ? l.flags |= 16384 : (e = l.updateQueue, e === null ? l.updateQueue = /* @__PURE__ */ new Set([n]) : e.add(n), Tf(t, n, a)), !1;
          case 22:
            return l.flags |= 65536, n === $u ? l.flags |= 16384 : (e = l.updateQueue, e === null ? (e = {
              transitions: null,
              markerInstances: null,
              retryQueue: /* @__PURE__ */ new Set([n])
            }, l.updateQueue = e) : (l = e.retryQueue, l === null ? e.retryQueue = /* @__PURE__ */ new Set([n]) : l.add(n)), Tf(t, n, a)), !1;
        }
        throw Error(r(435, l.tag));
      }
      return Tf(t, n, a), pi(), !1;
    }
    if (Et)
      return e = je.current, e !== null ? (!(e.flags & 65536) && (e.flags |= 256), e.flags |= 65536, e.lanes = a, n !== bc && (t = Error(r(422), { cause: n }), Xa(We(t, l)))) : (n !== bc && (e = Error(r(423), {
        cause: n
      }), Xa(
        We(e, l)
      )), t = t.current.alternate, t.flags |= 65536, a &= -a, t.lanes |= a, n = We(n, l), a = Ic(
        t.stateNode,
        n,
        a
      ), Mc(t, a), Wt !== 4 && (Wt = 2)), !1;
    var u = Error(r(520), { cause: n });
    if (u = We(u, l), iu === null ? iu = [u] : iu.push(u), Wt !== 4 && (Wt = 2), e === null) return !0;
    n = We(n, l), l = e;
    do {
      switch (l.tag) {
        case 3:
          return l.flags |= 65536, t = a & -a, l.lanes |= t, t = Ic(l.stateNode, n, t), Mc(l, t), !1;
        case 1:
          if (e = l.type, u = l.stateNode, (l.flags & 128) === 0 && (typeof e.getDerivedStateFromError == "function" || u !== null && typeof u.componentDidCatch == "function" && (Pl === null || !Pl.has(u))))
            return l.flags |= 65536, a &= -a, l.lanes |= a, a = Vo(a), ko(
              a,
              t,
              l,
              n
            ), Mc(l, a), !1;
      }
      l = l.return;
    } while (l !== null);
    return !1;
  }
  var Fc = Error(r(461)), fe = !1;
  function Ee(t, e, l, n) {
    e.child = t === null ? Ws(e, null, l, n) : zn(
      e,
      t.child,
      l,
      n
    );
  }
  function Jo(t, e, l, n, a) {
    l = l.render;
    var u = e.ref;
    if ("ref" in n) {
      var i = {};
      for (var c in n)
        c !== "ref" && (i[c] = n[c]);
    } else i = n;
    return On(e), n = xc(
      t,
      e,
      l,
      i,
      u,
      a
    ), c = Bc(), t !== null && !fe ? (Hc(t, e, a), Nl(t, e, a)) : (Et && c && mc(e), e.flags |= 1, Ee(t, e, n, a), e.child);
  }
  function $o(t, e, l, n, a) {
    if (t === null) {
      var u = l.type;
      return typeof u == "function" && !rc(u) && u.defaultProps === void 0 && l.compare === null ? (e.tag = 15, e.type = u, Wo(
        t,
        e,
        u,
        n,
        a
      )) : (t = ju(
        l.type,
        null,
        n,
        e,
        e.mode,
        a
      ), t.ref = e.ref, t.return = e, e.child = t);
    }
    if (u = t.child, !cf(t, a)) {
      var i = u.memoizedProps;
      if (l = l.compare, l = l !== null ? l : qa, l(i, n) && t.ref === e.ref)
        return Nl(t, e, a);
    }
    return e.flags |= 1, t = pl(u, n), t.ref = e.ref, t.return = e, e.child = t;
  }
  function Wo(t, e, l, n, a) {
    if (t !== null) {
      var u = t.memoizedProps;
      if (qa(u, n) && t.ref === e.ref)
        if (fe = !1, e.pendingProps = n = u, cf(t, a))
          t.flags & 131072 && (fe = !0);
        else
          return e.lanes = t.lanes, Nl(t, e, a);
    }
    return Pc(
      t,
      e,
      l,
      n,
      a
    );
  }
  function Io(t, e, l, n) {
    var a = n.children, u = t !== null ? t.memoizedState : null;
    if (t === null && e.stateNode === null && (e.stateNode = {
      _visibility: 1,
      _pendingMarkers: null,
      _retryCache: null,
      _transitions: null
    }), n.mode === "hidden") {
      if (e.flags & 128) {
        if (u = u !== null ? u.baseLanes | l : l, t !== null) {
          for (n = e.child = t.child, a = 0; n !== null; )
            a = a | n.lanes | n.childLanes, n = n.sibling;
          n = a & ~u;
        } else n = 0, e.child = null;
        return Fo(
          t,
          e,
          u,
          l,
          n
        );
      }
      if (l & 536870912)
        e.memoizedState = { baseLanes: 0, cachePool: null }, t !== null && ku(
          e,
          u !== null ? u.cachePool : null
        ), u !== null ? Ps(e, u) : zc(), to(e);
      else
        return n = e.lanes = 536870912, Fo(
          t,
          e,
          u !== null ? u.baseLanes | l : l,
          l,
          n
        );
    } else
      u !== null ? (ku(e, u.cachePool), Ps(e, u), $l(), e.memoizedState = null) : (t !== null && ku(e, null), zc(), $l());
    return Ee(t, e, a, l), e.child;
  }
  function Pa(t, e) {
    return t !== null && t.tag === 22 || e.stateNode !== null || (e.stateNode = {
      _visibility: 1,
      _pendingMarkers: null,
      _retryCache: null,
      _transitions: null
    }), e.sibling;
  }
  function Fo(t, e, l, n, a) {
    var u = Tc();
    return u = u === null ? null : { parent: ie._currentValue, pool: u }, e.memoizedState = {
      baseLanes: l,
      cachePool: u
    }, t !== null && ku(e, null), zc(), to(e), t !== null && Fn(t, e, n, !0), e.childLanes = a, null;
  }
  function si(t, e) {
    return e = ri(
      { mode: e.mode, children: e.children },
      t.mode
    ), e.ref = t.ref, t.child = e, e.return = t, e;
  }
  function Po(t, e, l) {
    return zn(e, t.child, null, l), t = si(e, e.pendingProps), t.flags |= 2, Qe(e), e.memoizedState = null, t;
  }
  function im(t, e, l) {
    var n = e.pendingProps, a = (e.flags & 128) !== 0;
    if (e.flags &= -129, t === null) {
      if (Et) {
        if (n.mode === "hidden")
          return t = si(e, n), e.lanes = 536870912, Pa(null, t);
        if (Cc(e), (t = Xt) ? (t = rd(
          t,
          Pe
        ), t = t !== null && t.data === "&" ? t : null, t !== null && (e.memoizedState = {
          dehydrated: t,
          treeContext: Xl !== null ? { id: sl, overflow: ol } : null,
          retryLane: 536870912,
          hydrationErrors: null
        }, l = Hs(t), l.return = e, e.child = l, ye = e, Xt = null)) : t = null, t === null) throw jl(e);
        return e.lanes = 536870912, null;
      }
      return si(e, n);
    }
    var u = t.memoizedState;
    if (u !== null) {
      var i = u.dehydrated;
      if (Cc(e), a)
        if (e.flags & 256)
          e.flags &= -257, e = Po(
            t,
            e,
            l
          );
        else if (e.memoizedState !== null)
          e.child = t.child, e.flags |= 128, e = null;
        else throw Error(r(558));
      else if (fe || Fn(t, e, l, !1), a = (l & t.childLanes) !== 0, fe || a) {
        if (n = Gt, n !== null && (i = Ft(n, l), i !== 0 && i !== u.retryLane))
          throw u.retryLane = i, Sn(t, i), Le(n, t, i), Fc;
        pi(), e = Po(
          t,
          e,
          l
        );
      } else
        t = u.treeContext, Xt = el(i.nextSibling), ye = e, Et = !0, Zl = null, Pe = !1, t !== null && qs(e, t), e = si(e, n), e.flags |= 4096;
      return e;
    }
    return t = pl(t.child, {
      mode: n.mode,
      children: n.children
    }), t.ref = e.ref, e.child = t, t.return = e, t;
  }
  function oi(t, e) {
    var l = e.ref;
    if (l === null)
      t !== null && t.ref !== null && (e.flags |= 4194816);
    else {
      if (typeof l != "function" && typeof l != "object")
        throw Error(r(284));
      (t === null || t.ref !== l) && (e.flags |= 4194816);
    }
  }
  function Pc(t, e, l, n, a) {
    return On(e), l = xc(
      t,
      e,
      l,
      n,
      void 0,
      a
    ), n = Bc(), t !== null && !fe ? (Hc(t, e, a), Nl(t, e, a)) : (Et && n && mc(e), e.flags |= 1, Ee(t, e, l, a), e.child);
  }
  function tr(t, e, l, n, a, u) {
    return On(e), e.updateQueue = null, l = lo(
      e,
      n,
      l,
      a
    ), eo(t), n = Bc(), t !== null && !fe ? (Hc(t, e, u), Nl(t, e, u)) : (Et && n && mc(e), e.flags |= 1, Ee(t, e, l, u), e.child);
  }
  function er(t, e, l, n, a) {
    if (On(e), e.stateNode === null) {
      var u = Jn, i = l.contextType;
      typeof i == "object" && i !== null && (u = ve(i)), u = new l(n, u), e.memoizedState = u.state !== null && u.state !== void 0 ? u.state : null, u.updater = Wc, e.stateNode = u, u._reactInternals = e, u = e.stateNode, u.props = n, u.state = e.memoizedState, u.refs = {}, Oc(e), i = l.contextType, u.context = typeof i == "object" && i !== null ? ve(i) : Jn, u.state = e.memoizedState, i = l.getDerivedStateFromProps, typeof i == "function" && ($c(
        e,
        l,
        i,
        n
      ), u.state = e.memoizedState), typeof l.getDerivedStateFromProps == "function" || typeof u.getSnapshotBeforeUpdate == "function" || typeof u.UNSAFE_componentWillMount != "function" && typeof u.componentWillMount != "function" || (i = u.state, typeof u.componentWillMount == "function" && u.componentWillMount(), typeof u.UNSAFE_componentWillMount == "function" && u.UNSAFE_componentWillMount(), i !== u.state && Wc.enqueueReplaceState(u, u.state, null), Ja(e, n, u, a), ka(), u.state = e.memoizedState), typeof u.componentDidMount == "function" && (e.flags |= 4194308), n = !0;
    } else if (t === null) {
      u = e.stateNode;
      var c = e.memoizedProps, f = Cn(l, c);
      u.props = f;
      var b = u.context, S = l.contextType;
      i = Jn, typeof S == "object" && S !== null && (i = ve(S));
      var O = l.getDerivedStateFromProps;
      S = typeof O == "function" || typeof u.getSnapshotBeforeUpdate == "function", c = e.pendingProps !== c, S || typeof u.UNSAFE_componentWillReceiveProps != "function" && typeof u.componentWillReceiveProps != "function" || (c || b !== i) && Xo(
        e,
        u,
        n,
        i
      ), Kl = !1;
      var y = e.memoizedState;
      u.state = y, Ja(e, n, u, a), ka(), b = e.memoizedState, c || y !== b || Kl ? (typeof O == "function" && ($c(
        e,
        l,
        O,
        n
      ), b = e.memoizedState), (f = Kl || wo(
        e,
        l,
        f,
        n,
        y,
        b,
        i
      )) ? (S || typeof u.UNSAFE_componentWillMount != "function" && typeof u.componentWillMount != "function" || (typeof u.componentWillMount == "function" && u.componentWillMount(), typeof u.UNSAFE_componentWillMount == "function" && u.UNSAFE_componentWillMount()), typeof u.componentDidMount == "function" && (e.flags |= 4194308)) : (typeof u.componentDidMount == "function" && (e.flags |= 4194308), e.memoizedProps = n, e.memoizedState = b), u.props = n, u.state = b, u.context = i, n = f) : (typeof u.componentDidMount == "function" && (e.flags |= 4194308), n = !1);
    } else {
      u = e.stateNode, Nc(t, e), i = e.memoizedProps, S = Cn(l, i), u.props = S, O = e.pendingProps, y = u.context, b = l.contextType, f = Jn, typeof b == "object" && b !== null && (f = ve(b)), c = l.getDerivedStateFromProps, (b = typeof c == "function" || typeof u.getSnapshotBeforeUpdate == "function") || typeof u.UNSAFE_componentWillReceiveProps != "function" && typeof u.componentWillReceiveProps != "function" || (i !== O || y !== f) && Xo(
        e,
        u,
        n,
        f
      ), Kl = !1, y = e.memoizedState, u.state = y, Ja(e, n, u, a), ka();
      var v = e.memoizedState;
      i !== O || y !== v || Kl || t !== null && t.dependencies !== null && Ku(t.dependencies) ? (typeof c == "function" && ($c(
        e,
        l,
        c,
        n
      ), v = e.memoizedState), (S = Kl || wo(
        e,
        l,
        S,
        n,
        y,
        v,
        f
      ) || t !== null && t.dependencies !== null && Ku(t.dependencies)) ? (b || typeof u.UNSAFE_componentWillUpdate != "function" && typeof u.componentWillUpdate != "function" || (typeof u.componentWillUpdate == "function" && u.componentWillUpdate(n, v, f), typeof u.UNSAFE_componentWillUpdate == "function" && u.UNSAFE_componentWillUpdate(
        n,
        v,
        f
      )), typeof u.componentDidUpdate == "function" && (e.flags |= 4), typeof u.getSnapshotBeforeUpdate == "function" && (e.flags |= 1024)) : (typeof u.componentDidUpdate != "function" || i === t.memoizedProps && y === t.memoizedState || (e.flags |= 4), typeof u.getSnapshotBeforeUpdate != "function" || i === t.memoizedProps && y === t.memoizedState || (e.flags |= 1024), e.memoizedProps = n, e.memoizedState = v), u.props = n, u.state = v, u.context = f, n = S) : (typeof u.componentDidUpdate != "function" || i === t.memoizedProps && y === t.memoizedState || (e.flags |= 4), typeof u.getSnapshotBeforeUpdate != "function" || i === t.memoizedProps && y === t.memoizedState || (e.flags |= 1024), n = !1);
    }
    return u = n, oi(t, e), n = (e.flags & 128) !== 0, u || n ? (u = e.stateNode, l = n && typeof l.getDerivedStateFromError != "function" ? null : u.render(), e.flags |= 1, t !== null && n ? (e.child = zn(
      e,
      t.child,
      null,
      a
    ), e.child = zn(
      e,
      null,
      l,
      a
    )) : Ee(t, e, l, a), e.memoizedState = u.state, t = e.child) : t = Nl(
      t,
      e,
      a
    ), t;
  }
  function lr(t, e, l, n) {
    return Tn(), e.flags |= 256, Ee(t, e, l, n), e.child;
  }
  var tf = {
    dehydrated: null,
    treeContext: null,
    retryLane: 0,
    hydrationErrors: null
  };
  function ef(t) {
    return { baseLanes: t, cachePool: Qs() };
  }
  function lf(t, e, l) {
    return t = t !== null ? t.childLanes & ~l : 0, e && (t |= Ve), t;
  }
  function nr(t, e, l) {
    var n = e.pendingProps, a = !1, u = (e.flags & 128) !== 0, i;
    if ((i = u) || (i = t !== null && t.memoizedState === null ? !1 : (ee.current & 2) !== 0), i && (a = !0, e.flags &= -129), i = (e.flags & 32) !== 0, e.flags &= -33, t === null) {
      if (Et) {
        if (a ? Jl(e) : $l(), (t = Xt) ? (t = rd(
          t,
          Pe
        ), t = t !== null && t.data !== "&" ? t : null, t !== null && (e.memoizedState = {
          dehydrated: t,
          treeContext: Xl !== null ? { id: sl, overflow: ol } : null,
          retryLane: 536870912,
          hydrationErrors: null
        }, l = Hs(t), l.return = e, e.child = l, ye = e, Xt = null)) : t = null, t === null) throw jl(e);
        return Yf(t) ? e.lanes = 32 : e.lanes = 536870912, null;
      }
      var c = n.children;
      return n = n.fallback, a ? ($l(), a = e.mode, c = ri(
        { mode: "hidden", children: c },
        a
      ), n = _n(
        n,
        a,
        l,
        null
      ), c.return = e, n.return = e, c.sibling = n, e.child = c, n = e.child, n.memoizedState = ef(l), n.childLanes = lf(
        t,
        i,
        l
      ), e.memoizedState = tf, Pa(null, n)) : (Jl(e), nf(e, c));
    }
    var f = t.memoizedState;
    if (f !== null && (c = f.dehydrated, c !== null)) {
      if (u)
        e.flags & 256 ? (Jl(e), e.flags &= -257, e = af(
          t,
          e,
          l
        )) : e.memoizedState !== null ? ($l(), e.child = t.child, e.flags |= 128, e = null) : ($l(), c = n.fallback, a = e.mode, n = ri(
          { mode: "visible", children: n.children },
          a
        ), c = _n(
          c,
          a,
          l,
          null
        ), c.flags |= 2, n.return = e, c.return = e, n.sibling = c, e.child = n, zn(
          e,
          t.child,
          null,
          l
        ), n = e.child, n.memoizedState = ef(l), n.childLanes = lf(
          t,
          i,
          l
        ), e.memoizedState = tf, e = Pa(null, n));
      else if (Jl(e), Yf(c)) {
        if (i = c.nextSibling && c.nextSibling.dataset, i) var b = i.dgst;
        i = b, n = Error(r(419)), n.stack = "", n.digest = i, Xa({ value: n, source: null, stack: null }), e = af(
          t,
          e,
          l
        );
      } else if (fe || Fn(t, e, l, !1), i = (l & t.childLanes) !== 0, fe || i) {
        if (i = Gt, i !== null && (n = Ft(i, l), n !== 0 && n !== f.retryLane))
          throw f.retryLane = n, Sn(t, n), Le(i, t, n), Fc;
        qf(c) || pi(), e = af(
          t,
          e,
          l
        );
      } else
        qf(c) ? (e.flags |= 192, e.child = t.child, e = null) : (t = f.treeContext, Xt = el(
          c.nextSibling
        ), ye = e, Et = !0, Zl = null, Pe = !1, t !== null && qs(e, t), e = nf(
          e,
          n.children
        ), e.flags |= 4096);
      return e;
    }
    return a ? ($l(), c = n.fallback, a = e.mode, f = t.child, b = f.sibling, n = pl(f, {
      mode: "hidden",
      children: n.children
    }), n.subtreeFlags = f.subtreeFlags & 65011712, b !== null ? c = pl(
      b,
      c
    ) : (c = _n(
      c,
      a,
      l,
      null
    ), c.flags |= 2), c.return = e, n.return = e, n.sibling = c, e.child = n, Pa(null, n), n = e.child, c = t.child.memoizedState, c === null ? c = ef(l) : (a = c.cachePool, a !== null ? (f = ie._currentValue, a = a.parent !== f ? { parent: f, pool: f } : a) : a = Qs(), c = {
      baseLanes: c.baseLanes | l,
      cachePool: a
    }), n.memoizedState = c, n.childLanes = lf(
      t,
      i,
      l
    ), e.memoizedState = tf, Pa(t.child, n)) : (Jl(e), l = t.child, t = l.sibling, l = pl(l, {
      mode: "visible",
      children: n.children
    }), l.return = e, l.sibling = null, t !== null && (i = e.deletions, i === null ? (e.deletions = [t], e.flags |= 16) : i.push(t)), e.child = l, e.memoizedState = null, l);
  }
  function nf(t, e) {
    return e = ri(
      { mode: "visible", children: e },
      t.mode
    ), e.return = t, t.child = e;
  }
  function ri(t, e) {
    return t = Ze(22, t, null, e), t.lanes = 0, t;
  }
  function af(t, e, l) {
    return zn(e, t.child, null, l), t = nf(
      e,
      e.pendingProps.children
    ), t.flags |= 2, e.memoizedState = null, t;
  }
  function ar(t, e, l) {
    t.lanes |= e;
    var n = t.alternate;
    n !== null && (n.lanes |= e), Ec(t.return, e, l);
  }
  function uf(t, e, l, n, a, u) {
    var i = t.memoizedState;
    i === null ? t.memoizedState = {
      isBackwards: e,
      rendering: null,
      renderingStartTime: 0,
      last: n,
      tail: l,
      tailMode: a,
      treeForkCount: u
    } : (i.isBackwards = e, i.rendering = null, i.renderingStartTime = 0, i.last = n, i.tail = l, i.tailMode = a, i.treeForkCount = u);
  }
  function ur(t, e, l) {
    var n = e.pendingProps, a = n.revealOrder, u = n.tail;
    n = n.children;
    var i = ee.current, c = (i & 2) !== 0;
    if (c ? (i = i & 1 | 2, e.flags |= 128) : i &= 1, C(ee, i), Ee(t, e, n, l), n = Et ? wa : 0, !c && t !== null && t.flags & 128)
      t: for (t = e.child; t !== null; ) {
        if (t.tag === 13)
          t.memoizedState !== null && ar(t, l, e);
        else if (t.tag === 19)
          ar(t, l, e);
        else if (t.child !== null) {
          t.child.return = t, t = t.child;
          continue;
        }
        if (t === e) break t;
        for (; t.sibling === null; ) {
          if (t.return === null || t.return === e)
            break t;
          t = t.return;
        }
        t.sibling.return = t.return, t = t.sibling;
      }
    switch (a) {
      case "forwards":
        for (l = e.child, a = null; l !== null; )
          t = l.alternate, t !== null && Pu(t) === null && (a = l), l = l.sibling;
        l = a, l === null ? (a = e.child, e.child = null) : (a = l.sibling, l.sibling = null), uf(
          e,
          !1,
          a,
          l,
          u,
          n
        );
        break;
      case "backwards":
      case "unstable_legacy-backwards":
        for (l = null, a = e.child, e.child = null; a !== null; ) {
          if (t = a.alternate, t !== null && Pu(t) === null) {
            e.child = a;
            break;
          }
          t = a.sibling, a.sibling = l, l = a, a = t;
        }
        uf(
          e,
          !0,
          l,
          null,
          u,
          n
        );
        break;
      case "together":
        uf(
          e,
          !1,
          null,
          null,
          void 0,
          n
        );
        break;
      default:
        e.memoizedState = null;
    }
    return e.child;
  }
  function Nl(t, e, l) {
    if (t !== null && (e.dependencies = t.dependencies), Fl |= e.lanes, !(l & e.childLanes))
      if (t !== null) {
        if (Fn(
          t,
          e,
          l,
          !1
        ), (l & e.childLanes) === 0)
          return null;
      } else return null;
    if (t !== null && e.child !== t.child)
      throw Error(r(153));
    if (e.child !== null) {
      for (t = e.child, l = pl(t, t.pendingProps), e.child = l, l.return = e; t.sibling !== null; )
        t = t.sibling, l = l.sibling = pl(t, t.pendingProps), l.return = e;
      l.sibling = null;
    }
    return e.child;
  }
  function cf(t, e) {
    return t.lanes & e ? !0 : (t = t.dependencies, !!(t !== null && Ku(t)));
  }
  function cm(t, e, l) {
    switch (e.tag) {
      case 3:
        he(e, e.stateNode.containerInfo), Ql(e, ie, t.memoizedState.cache), Tn();
        break;
      case 27:
      case 5:
        il(e);
        break;
      case 4:
        he(e, e.stateNode.containerInfo);
        break;
      case 10:
        Ql(
          e,
          e.type,
          e.memoizedProps.value
        );
        break;
      case 31:
        if (e.memoizedState !== null)
          return e.flags |= 128, Cc(e), null;
        break;
      case 13:
        var n = e.memoizedState;
        if (n !== null)
          return n.dehydrated !== null ? (Jl(e), e.flags |= 128, null) : l & e.child.childLanes ? nr(t, e, l) : (Jl(e), t = Nl(
            t,
            e,
            l
          ), t !== null ? t.sibling : null);
        Jl(e);
        break;
      case 19:
        var a = (t.flags & 128) !== 0;
        if (n = (l & e.childLanes) !== 0, n || (Fn(
          t,
          e,
          l,
          !1
        ), n = (l & e.childLanes) !== 0), a) {
          if (n)
            return ur(
              t,
              e,
              l
            );
          e.flags |= 128;
        }
        if (a = e.memoizedState, a !== null && (a.rendering = null, a.tail = null, a.lastEffect = null), C(ee, ee.current), n) break;
        return null;
      case 22:
        return e.lanes = 0, Io(
          t,
          e,
          l,
          e.pendingProps
        );
      case 24:
        Ql(e, ie, t.memoizedState.cache);
    }
    return Nl(t, e, l);
  }
  function ir(t, e, l) {
    if (t !== null)
      if (t.memoizedProps !== e.pendingProps)
        fe = !0;
      else {
        if (!cf(t, l) && !(e.flags & 128))
          return fe = !1, cm(
            t,
            e,
            l
          );
        fe = !!(t.flags & 131072);
      }
    else
      fe = !1, Et && e.flags & 1048576 && Gs(e, wa, e.index);
    switch (e.lanes = 0, e.tag) {
      case 16:
        t: {
          var n = e.pendingProps;
          if (t = Mn(e.elementType), e.type = t, typeof t == "function")
            rc(t) ? (n = Cn(t, n), e.tag = 1, e = er(
              null,
              e,
              t,
              n,
              l
            )) : (e.tag = 0, e = Pc(
              null,
              e,
              t,
              n,
              l
            ));
          else {
            if (t != null) {
              var a = t.$$typeof;
              if (a === jt) {
                e.tag = 11, e = Jo(
                  null,
                  e,
                  t,
                  n,
                  l
                );
                break t;
              } else if (a === tt) {
                e.tag = 14, e = $o(
                  null,
                  e,
                  t,
                  n,
                  l
                );
                break t;
              }
            }
            throw e = oe(t) || t, Error(r(306, e, ""));
          }
        }
        return e;
      case 0:
        return Pc(
          t,
          e,
          e.type,
          e.pendingProps,
          l
        );
      case 1:
        return n = e.type, a = Cn(
          n,
          e.pendingProps
        ), er(
          t,
          e,
          n,
          a,
          l
        );
      case 3:
        t: {
          if (he(
            e,
            e.stateNode.containerInfo
          ), t === null) throw Error(r(387));
          n = e.pendingProps;
          var u = e.memoizedState;
          a = u.element, Nc(t, e), Ja(e, n, null, l);
          var i = e.memoizedState;
          if (n = i.cache, Ql(e, ie, n), n !== u.cache && pc(
            e,
            [ie],
            l,
            !0
          ), ka(), n = i.element, u.isDehydrated)
            if (u = {
              element: n,
              isDehydrated: !1,
              cache: i.cache
            }, e.updateQueue.baseState = u, e.memoizedState = u, e.flags & 256) {
              e = lr(
                t,
                e,
                n,
                l
              );
              break t;
            } else if (n !== a) {
              a = We(
                Error(r(424)),
                e
              ), Xa(a), e = lr(
                t,
                e,
                n,
                l
              );
              break t;
            } else {
              switch (t = e.stateNode.containerInfo, t.nodeType) {
                case 9:
                  t = t.body;
                  break;
                default:
                  t = t.nodeName === "HTML" ? t.ownerDocument.body : t;
              }
              for (Xt = el(t.firstChild), ye = e, Et = !0, Zl = null, Pe = !0, l = Ws(
                e,
                null,
                n,
                l
              ), e.child = l; l; )
                l.flags = l.flags & -3 | 4096, l = l.sibling;
            }
          else {
            if (Tn(), n === a) {
              e = Nl(
                t,
                e,
                l
              );
              break t;
            }
            Ee(t, e, n, l);
          }
          e = e.child;
        }
        return e;
      case 26:
        return oi(t, e), t === null ? (l = yd(
          e.type,
          null,
          e.pendingProps,
          null
        )) ? e.memoizedState = l : Et || (l = e.type, t = e.pendingProps, n = Mi(
          ot.current
        ).createElement(l), n[Pt] = e, n[_e] = t, pe(n, l, t), ae(n), e.stateNode = n) : e.memoizedState = yd(
          e.type,
          t.memoizedProps,
          e.pendingProps,
          t.memoizedState
        ), null;
      case 27:
        return il(e), t === null && Et && (n = e.stateNode = md(
          e.type,
          e.pendingProps,
          ot.current
        ), ye = e, Pe = !0, a = Xt, nn(e.type) ? (wf = a, Xt = el(n.firstChild)) : Xt = a), Ee(
          t,
          e,
          e.pendingProps.children,
          l
        ), oi(t, e), t === null && (e.flags |= 4194304), e.child;
      case 5:
        return t === null && Et && ((a = n = Xt) && (n = Gm(
          n,
          e.type,
          e.pendingProps,
          Pe
        ), n !== null ? (e.stateNode = n, ye = e, Xt = el(n.firstChild), Pe = !1, a = !0) : a = !1), a || jl(e)), il(e), a = e.type, u = e.pendingProps, i = t !== null ? t.memoizedProps : null, n = u.children, Hf(a, u) ? n = null : i !== null && Hf(a, i) && (e.flags |= 32), e.memoizedState !== null && (a = xc(
          t,
          e,
          Fg,
          null,
          null,
          l
        ), mu._currentValue = a), oi(t, e), Ee(t, e, n, l), e.child;
      case 6:
        return t === null && Et && ((t = l = Xt) && (l = qm(
          l,
          e.pendingProps,
          Pe
        ), l !== null ? (e.stateNode = l, ye = e, Xt = null, t = !0) : t = !1), t || jl(e)), null;
      case 13:
        return nr(t, e, l);
      case 4:
        return he(
          e,
          e.stateNode.containerInfo
        ), n = e.pendingProps, t === null ? e.child = zn(
          e,
          null,
          n,
          l
        ) : Ee(t, e, n, l), e.child;
      case 11:
        return Jo(
          t,
          e,
          e.type,
          e.pendingProps,
          l
        );
      case 7:
        return Ee(
          t,
          e,
          e.pendingProps,
          l
        ), e.child;
      case 8:
        return Ee(
          t,
          e,
          e.pendingProps.children,
          l
        ), e.child;
      case 12:
        return Ee(
          t,
          e,
          e.pendingProps.children,
          l
        ), e.child;
      case 10:
        return n = e.pendingProps, Ql(e, e.type, n.value), Ee(t, e, n.children, l), e.child;
      case 9:
        return a = e.type._context, n = e.pendingProps.children, On(e), a = ve(a), n = n(a), e.flags |= 1, Ee(t, e, n, l), e.child;
      case 14:
        return $o(
          t,
          e,
          e.type,
          e.pendingProps,
          l
        );
      case 15:
        return Wo(
          t,
          e,
          e.type,
          e.pendingProps,
          l
        );
      case 19:
        return ur(t, e, l);
      case 31:
        return im(t, e, l);
      case 22:
        return Io(
          t,
          e,
          l,
          e.pendingProps
        );
      case 24:
        return On(e), n = ve(ie), t === null ? (a = Tc(), a === null && (a = Gt, u = Sc(), a.pooledCache = u, u.refCount++, u !== null && (a.pooledCacheLanes |= l), a = u), e.memoizedState = { parent: n, cache: a }, Oc(e), Ql(e, ie, a)) : (t.lanes & l && (Nc(t, e), Ja(e, null, null, l), ka()), a = t.memoizedState, u = e.memoizedState, a.parent !== n ? (a = { parent: n, cache: n }, e.memoizedState = a, e.lanes === 0 && (e.memoizedState = e.updateQueue.baseState = a), Ql(e, ie, n)) : (n = u.cache, Ql(e, ie, n), n !== a.cache && pc(
          e,
          [ie],
          l,
          !0
        ))), Ee(
          t,
          e,
          e.pendingProps.children,
          l
        ), e.child;
      case 29:
        throw e.pendingProps;
    }
    throw Error(r(156, e.tag));
  }
  function Ml(t) {
    t.flags |= 4;
  }
  function ff(t, e, l, n, a) {
    if ((e = (t.mode & 32) !== 0) && (e = !1), e) {
      if (t.flags |= 16777216, (a & 335544128) === a)
        if (t.stateNode.complete) t.flags |= 8192;
        else if (xr()) t.flags |= 8192;
        else
          throw Rn = $u, Ac;
    } else t.flags &= -16777217;
  }
  function cr(t, e) {
    if (e.type !== "stylesheet" || e.state.loading & 4)
      t.flags &= -16777217;
    else if (t.flags |= 16777216, !_d(e))
      if (xr()) t.flags |= 8192;
      else
        throw Rn = $u, Ac;
  }
  function di(t, e) {
    e !== null && (t.flags |= 4), t.flags & 16384 && (e = t.tag !== 22 ? P() : 536870912, t.lanes |= e, oa |= e);
  }
  function tu(t, e) {
    if (!Et)
      switch (t.tailMode) {
        case "hidden":
          e = t.tail;
          for (var l = null; e !== null; )
            e.alternate !== null && (l = e), e = e.sibling;
          l === null ? t.tail = null : l.sibling = null;
          break;
        case "collapsed":
          l = t.tail;
          for (var n = null; l !== null; )
            l.alternate !== null && (n = l), l = l.sibling;
          n === null ? e || t.tail === null ? t.tail = null : t.tail.sibling = null : n.sibling = null;
      }
  }
  function Zt(t) {
    var e = t.alternate !== null && t.alternate.child === t.child, l = 0, n = 0;
    if (e)
      for (var a = t.child; a !== null; )
        l |= a.lanes | a.childLanes, n |= a.subtreeFlags & 65011712, n |= a.flags & 65011712, a.return = t, a = a.sibling;
    else
      for (a = t.child; a !== null; )
        l |= a.lanes | a.childLanes, n |= a.subtreeFlags, n |= a.flags, a.return = t, a = a.sibling;
    return t.subtreeFlags |= n, t.childLanes = l, e;
  }
  function fm(t, e, l) {
    var n = e.pendingProps;
    switch (hc(e), e.tag) {
      case 16:
      case 15:
      case 0:
      case 11:
      case 7:
      case 8:
      case 12:
      case 9:
      case 14:
        return Zt(e), null;
      case 1:
        return Zt(e), null;
      case 3:
        return l = e.stateNode, n = null, t !== null && (n = t.memoizedState.cache), e.memoizedState.cache !== n && (e.flags |= 2048), Tl(ie), Jt(), l.pendingContext && (l.context = l.pendingContext, l.pendingContext = null), (t === null || t.child === null) && (In(e) ? Ml(e) : t === null || t.memoizedState.isDehydrated && !(e.flags & 256) || (e.flags |= 1024, yc())), Zt(e), null;
      case 26:
        var a = e.type, u = e.memoizedState;
        return t === null ? (Ml(e), u !== null ? (Zt(e), cr(e, u)) : (Zt(e), ff(
          e,
          a,
          null,
          n,
          l
        ))) : u ? u !== t.memoizedState ? (Ml(e), Zt(e), cr(e, u)) : (Zt(e), e.flags &= -16777217) : (t = t.memoizedProps, t !== n && Ml(e), Zt(e), ff(
          e,
          a,
          t,
          n,
          l
        )), null;
      case 27:
        if (Bn(e), l = ot.current, a = e.type, t !== null && e.stateNode != null)
          t.memoizedProps !== n && Ml(e);
        else {
          if (!n) {
            if (e.stateNode === null)
              throw Error(r(166));
            return Zt(e), null;
          }
          t = q.current, In(e) ? Ys(e) : (t = md(a, n, l), e.stateNode = t, Ml(e));
        }
        return Zt(e), null;
      case 5:
        if (Bn(e), a = e.type, t !== null && e.stateNode != null)
          t.memoizedProps !== n && Ml(e);
        else {
          if (!n) {
            if (e.stateNode === null)
              throw Error(r(166));
            return Zt(e), null;
          }
          if (u = q.current, In(e))
            Ys(e);
          else {
            var i = Mi(
              ot.current
            );
            switch (u) {
              case 1:
                u = i.createElementNS(
                  "http://www.w3.org/2000/svg",
                  a
                );
                break;
              case 2:
                u = i.createElementNS(
                  "http://www.w3.org/1998/Math/MathML",
                  a
                );
                break;
              default:
                switch (a) {
                  case "svg":
                    u = i.createElementNS(
                      "http://www.w3.org/2000/svg",
                      a
                    );
                    break;
                  case "math":
                    u = i.createElementNS(
                      "http://www.w3.org/1998/Math/MathML",
                      a
                    );
                    break;
                  case "script":
                    u = i.createElement("div"), u.innerHTML = "<script><\/script>", u = u.removeChild(
                      u.firstChild
                    );
                    break;
                  case "select":
                    u = typeof n.is == "string" ? i.createElement("select", {
                      is: n.is
                    }) : i.createElement("select"), n.multiple ? u.multiple = !0 : n.size && (u.size = n.size);
                    break;
                  default:
                    u = typeof n.is == "string" ? i.createElement(a, { is: n.is }) : i.createElement(a);
                }
            }
            u[Pt] = e, u[_e] = n;
            t: for (i = e.child; i !== null; ) {
              if (i.tag === 5 || i.tag === 6)
                u.appendChild(i.stateNode);
              else if (i.tag !== 4 && i.tag !== 27 && i.child !== null) {
                i.child.return = i, i = i.child;
                continue;
              }
              if (i === e) break t;
              for (; i.sibling === null; ) {
                if (i.return === null || i.return === e)
                  break t;
                i = i.return;
              }
              i.sibling.return = i.return, i = i.sibling;
            }
            e.stateNode = u;
            t: switch (pe(u, a, n), a) {
              case "button":
              case "input":
              case "select":
              case "textarea":
                n = !!n.autoFocus;
                break t;
              case "img":
                n = !0;
                break t;
              default:
                n = !1;
            }
            n && Ml(e);
          }
        }
        return Zt(e), ff(
          e,
          e.type,
          t === null ? null : t.memoizedProps,
          e.pendingProps,
          l
        ), null;
      case 6:
        if (t && e.stateNode != null)
          t.memoizedProps !== n && Ml(e);
        else {
          if (typeof n != "string" && e.stateNode === null)
            throw Error(r(166));
          if (t = ot.current, In(e)) {
            if (t = e.stateNode, l = e.memoizedProps, n = null, a = ye, a !== null)
              switch (a.tag) {
                case 27:
                case 5:
                  n = a.memoizedProps;
              }
            t[Pt] = e, t = !!(t.nodeValue === l || n !== null && n.suppressHydrationWarning === !0 || nd(t.nodeValue, l)), t || jl(e, !0);
          } else
            t = Mi(t).createTextNode(
              n
            ), t[Pt] = e, e.stateNode = t;
        }
        return Zt(e), null;
      case 31:
        if (l = e.memoizedState, t === null || t.memoizedState !== null) {
          if (n = In(e), l !== null) {
            if (t === null) {
              if (!n) throw Error(r(318));
              if (t = e.memoizedState, t = t !== null ? t.dehydrated : null, !t) throw Error(r(557));
              t[Pt] = e;
            } else
              Tn(), !(e.flags & 128) && (e.memoizedState = null), e.flags |= 4;
            Zt(e), t = !1;
          } else
            l = yc(), t !== null && t.memoizedState !== null && (t.memoizedState.hydrationErrors = l), t = !0;
          if (!t)
            return e.flags & 256 ? (Qe(e), e) : (Qe(e), null);
          if (e.flags & 128)
            throw Error(r(558));
        }
        return Zt(e), null;
      case 13:
        if (n = e.memoizedState, t === null || t.memoizedState !== null && t.memoizedState.dehydrated !== null) {
          if (a = In(e), n !== null && n.dehydrated !== null) {
            if (t === null) {
              if (!a) throw Error(r(318));
              if (a = e.memoizedState, a = a !== null ? a.dehydrated : null, !a) throw Error(r(317));
              a[Pt] = e;
            } else
              Tn(), !(e.flags & 128) && (e.memoizedState = null), e.flags |= 4;
            Zt(e), a = !1;
          } else
            a = yc(), t !== null && t.memoizedState !== null && (t.memoizedState.hydrationErrors = a), a = !0;
          if (!a)
            return e.flags & 256 ? (Qe(e), e) : (Qe(e), null);
        }
        return Qe(e), e.flags & 128 ? (e.lanes = l, e) : (l = n !== null, t = t !== null && t.memoizedState !== null, l && (n = e.child, a = null, n.alternate !== null && n.alternate.memoizedState !== null && n.alternate.memoizedState.cachePool !== null && (a = n.alternate.memoizedState.cachePool.pool), u = null, n.memoizedState !== null && n.memoizedState.cachePool !== null && (u = n.memoizedState.cachePool.pool), u !== a && (n.flags |= 2048)), l !== t && l && (e.child.flags |= 8192), di(e, e.updateQueue), Zt(e), null);
      case 4:
        return Jt(), t === null && Df(e.stateNode.containerInfo), Zt(e), null;
      case 10:
        return Tl(e.type), Zt(e), null;
      case 19:
        if (_(ee), n = e.memoizedState, n === null) return Zt(e), null;
        if (a = (e.flags & 128) !== 0, u = n.rendering, u === null)
          if (a) tu(n, !1);
          else {
            if (Wt !== 0 || t !== null && t.flags & 128)
              for (t = e.child; t !== null; ) {
                if (u = Pu(t), u !== null) {
                  for (e.flags |= 128, tu(n, !1), t = u.updateQueue, e.updateQueue = t, di(e, t), e.subtreeFlags = 0, t = l, l = e.child; l !== null; )
                    Bs(l, t), l = l.sibling;
                  return C(
                    ee,
                    ee.current & 1 | 2
                  ), Et && Sl(e, n.treeForkCount), e.child;
                }
                t = t.sibling;
              }
            n.tail !== null && It() > yi && (e.flags |= 128, a = !0, tu(n, !1), e.lanes = 4194304);
          }
        else {
          if (!a)
            if (t = Pu(u), t !== null) {
              if (e.flags |= 128, a = !0, t = t.updateQueue, e.updateQueue = t, di(e, t), tu(n, !0), n.tail === null && n.tailMode === "hidden" && !u.alternate && !Et)
                return Zt(e), null;
            } else
              2 * It() - n.renderingStartTime > yi && l !== 536870912 && (e.flags |= 128, a = !0, tu(n, !1), e.lanes = 4194304);
          n.isBackwards ? (u.sibling = e.child, e.child = u) : (t = n.last, t !== null ? t.sibling = u : e.child = u, n.last = u);
        }
        return n.tail !== null ? (t = n.tail, n.rendering = t, n.tail = t.sibling, n.renderingStartTime = It(), t.sibling = null, l = ee.current, C(
          ee,
          a ? l & 1 | 2 : l & 1
        ), Et && Sl(e, n.treeForkCount), t) : (Zt(e), null);
      case 22:
      case 23:
        return Qe(e), Dc(), n = e.memoizedState !== null, t !== null ? t.memoizedState !== null !== n && (e.flags |= 8192) : n && (e.flags |= 8192), n ? l & 536870912 && !(e.flags & 128) && (Zt(e), e.subtreeFlags & 6 && (e.flags |= 8192)) : Zt(e), l = e.updateQueue, l !== null && di(e, l.retryQueue), l = null, t !== null && t.memoizedState !== null && t.memoizedState.cachePool !== null && (l = t.memoizedState.cachePool.pool), n = null, e.memoizedState !== null && e.memoizedState.cachePool !== null && (n = e.memoizedState.cachePool.pool), n !== l && (e.flags |= 2048), t !== null && _(Nn), null;
      case 24:
        return l = null, t !== null && (l = t.memoizedState.cache), e.memoizedState.cache !== l && (e.flags |= 2048), Tl(ie), Zt(e), null;
      case 25:
        return null;
      case 30:
        return null;
    }
    throw Error(r(156, e.tag));
  }
  function sm(t, e) {
    switch (hc(e), e.tag) {
      case 1:
        return t = e.flags, t & 65536 ? (e.flags = t & -65537 | 128, e) : null;
      case 3:
        return Tl(ie), Jt(), t = e.flags, t & 65536 && !(t & 128) ? (e.flags = t & -65537 | 128, e) : null;
      case 26:
      case 27:
      case 5:
        return Bn(e), null;
      case 31:
        if (e.memoizedState !== null) {
          if (Qe(e), e.alternate === null)
            throw Error(r(340));
          Tn();
        }
        return t = e.flags, t & 65536 ? (e.flags = t & -65537 | 128, e) : null;
      case 13:
        if (Qe(e), t = e.memoizedState, t !== null && t.dehydrated !== null) {
          if (e.alternate === null)
            throw Error(r(340));
          Tn();
        }
        return t = e.flags, t & 65536 ? (e.flags = t & -65537 | 128, e) : null;
      case 19:
        return _(ee), null;
      case 4:
        return Jt(), null;
      case 10:
        return Tl(e.type), null;
      case 22:
      case 23:
        return Qe(e), Dc(), t !== null && _(Nn), t = e.flags, t & 65536 ? (e.flags = t & -65537 | 128, e) : null;
      case 24:
        return Tl(ie), null;
      case 25:
        return null;
      default:
        return null;
    }
  }
  function fr(t, e) {
    switch (hc(e), e.tag) {
      case 3:
        Tl(ie), Jt();
        break;
      case 26:
      case 27:
      case 5:
        Bn(e);
        break;
      case 4:
        Jt();
        break;
      case 31:
        e.memoizedState !== null && Qe(e);
        break;
      case 13:
        Qe(e);
        break;
      case 19:
        _(ee);
        break;
      case 10:
        Tl(e.type);
        break;
      case 22:
      case 23:
        Qe(e), Dc(), t !== null && _(Nn);
        break;
      case 24:
        Tl(ie);
    }
  }
  function eu(t, e) {
    try {
      var l = e.updateQueue, n = l !== null ? l.lastEffect : null;
      if (n !== null) {
        var a = n.next;
        l = a;
        do {
          if ((l.tag & t) === t) {
            n = void 0;
            var u = l.create, i = l.inst;
            n = u(), i.destroy = n;
          }
          l = l.next;
        } while (l !== a);
      }
    } catch (c) {
      Ct(e, e.return, c);
    }
  }
  function Wl(t, e, l) {
    try {
      var n = e.updateQueue, a = n !== null ? n.lastEffect : null;
      if (a !== null) {
        var u = a.next;
        n = u;
        do {
          if ((n.tag & t) === t) {
            var i = n.inst, c = i.destroy;
            if (c !== void 0) {
              i.destroy = void 0, a = e;
              var f = l, b = c;
              try {
                b();
              } catch (S) {
                Ct(
                  a,
                  f,
                  S
                );
              }
            }
          }
          n = n.next;
        } while (n !== u);
      }
    } catch (S) {
      Ct(e, e.return, S);
    }
  }
  function sr(t) {
    var e = t.updateQueue;
    if (e !== null) {
      var l = t.stateNode;
      try {
        Fs(e, l);
      } catch (n) {
        Ct(t, t.return, n);
      }
    }
  }
  function or(t, e, l) {
    l.props = Cn(
      t.type,
      t.memoizedProps
    ), l.state = t.memoizedState;
    try {
      l.componentWillUnmount();
    } catch (n) {
      Ct(t, e, n);
    }
  }
  function lu(t, e) {
    try {
      var l = t.ref;
      if (l !== null) {
        switch (t.tag) {
          case 26:
          case 27:
          case 5:
            var n = t.stateNode;
            break;
          case 30:
            n = t.stateNode;
            break;
          default:
            n = t.stateNode;
        }
        typeof l == "function" ? t.refCleanup = l(n) : l.current = n;
      }
    } catch (a) {
      Ct(t, e, a);
    }
  }
  function rl(t, e) {
    var l = t.ref, n = t.refCleanup;
    if (l !== null)
      if (typeof n == "function")
        try {
          n();
        } catch (a) {
          Ct(t, e, a);
        } finally {
          t.refCleanup = null, t = t.alternate, t != null && (t.refCleanup = null);
        }
      else if (typeof l == "function")
        try {
          l(null);
        } catch (a) {
          Ct(t, e, a);
        }
      else l.current = null;
  }
  function rr(t) {
    var e = t.type, l = t.memoizedProps, n = t.stateNode;
    try {
      t: switch (e) {
        case "button":
        case "input":
        case "select":
        case "textarea":
          l.autoFocus && n.focus();
          break t;
        case "img":
          l.src ? n.src = l.src : l.srcSet && (n.srcset = l.srcSet);
      }
    } catch (a) {
      Ct(t, t.return, a);
    }
  }
  function sf(t, e, l) {
    try {
      var n = t.stateNode;
      Cm(n, t.type, l, e), n[_e] = e;
    } catch (a) {
      Ct(t, t.return, a);
    }
  }
  function dr(t) {
    return t.tag === 5 || t.tag === 3 || t.tag === 26 || t.tag === 27 && nn(t.type) || t.tag === 4;
  }
  function of(t) {
    t: for (; ; ) {
      for (; t.sibling === null; ) {
        if (t.return === null || dr(t.return)) return null;
        t = t.return;
      }
      for (t.sibling.return = t.return, t = t.sibling; t.tag !== 5 && t.tag !== 6 && t.tag !== 18; ) {
        if (t.tag === 27 && nn(t.type) || t.flags & 2 || t.child === null || t.tag === 4) continue t;
        t.child.return = t, t = t.child;
      }
      if (!(t.flags & 2)) return t.stateNode;
    }
  }
  function rf(t, e, l) {
    var n = t.tag;
    if (n === 5 || n === 6)
      t = t.stateNode, e ? (l.nodeType === 9 ? l.body : l.nodeName === "HTML" ? l.ownerDocument.body : l).insertBefore(t, e) : (e = l.nodeType === 9 ? l.body : l.nodeName === "HTML" ? l.ownerDocument.body : l, e.appendChild(t), l = l._reactRootContainer, l != null || e.onclick !== null || (e.onclick = D));
    else if (n !== 4 && (n === 27 && nn(t.type) && (l = t.stateNode, e = null), t = t.child, t !== null))
      for (rf(t, e, l), t = t.sibling; t !== null; )
        rf(t, e, l), t = t.sibling;
  }
  function gi(t, e, l) {
    var n = t.tag;
    if (n === 5 || n === 6)
      t = t.stateNode, e ? l.insertBefore(t, e) : l.appendChild(t);
    else if (n !== 4 && (n === 27 && nn(t.type) && (l = t.stateNode), t = t.child, t !== null))
      for (gi(t, e, l), t = t.sibling; t !== null; )
        gi(t, e, l), t = t.sibling;
  }
  function gr(t) {
    var e = t.stateNode, l = t.memoizedProps;
    try {
      for (var n = t.type, a = e.attributes; a.length; )
        e.removeAttributeNode(a[0]);
      pe(e, n, l), e[Pt] = t, e[_e] = l;
    } catch (u) {
      Ct(t, t.return, u);
    }
  }
  var Rl = !1, se = !1, df = !1, mr = typeof WeakSet == "function" ? WeakSet : Set, de = null;
  function om(t, e) {
    if (t = t.containerInfo, xf = Bi, t = Os(t), ac(t)) {
      if ("selectionStart" in t)
        var l = {
          start: t.selectionStart,
          end: t.selectionEnd
        };
      else
        t: {
          l = (l = t.ownerDocument) && l.defaultView || window;
          var n = l.getSelection && l.getSelection();
          if (n && n.rangeCount !== 0) {
            l = n.anchorNode;
            var a = n.anchorOffset, u = n.focusNode;
            n = n.focusOffset;
            try {
              l.nodeType, u.nodeType;
            } catch {
              l = null;
              break t;
            }
            var i = 0, c = -1, f = -1, b = 0, S = 0, O = t, y = null;
            e: for (; ; ) {
              for (var v; O !== l || a !== 0 && O.nodeType !== 3 || (c = i + a), O !== u || n !== 0 && O.nodeType !== 3 || (f = i + n), O.nodeType === 3 && (i += O.nodeValue.length), (v = O.firstChild) !== null; )
                y = O, O = v;
              for (; ; ) {
                if (O === t) break e;
                if (y === l && ++b === a && (c = i), y === u && ++S === n && (f = i), (v = O.nextSibling) !== null) break;
                O = y, y = O.parentNode;
              }
              O = v;
            }
            l = c === -1 || f === -1 ? null : { start: c, end: f };
          } else l = null;
        }
      l = l || { start: 0, end: 0 };
    } else l = null;
    for (Bf = { focusedElem: t, selectionRange: l }, Bi = !1, de = e; de !== null; )
      if (e = de, t = e.child, (e.subtreeFlags & 1028) !== 0 && t !== null)
        t.return = e, de = t;
      else
        for (; de !== null; ) {
          switch (e = de, u = e.alternate, t = e.flags, e.tag) {
            case 0:
              if (t & 4 && (t = e.updateQueue, t = t !== null ? t.events : null, t !== null))
                for (l = 0; l < t.length; l++)
                  a = t[l], a.ref.impl = a.nextImpl;
              break;
            case 11:
            case 15:
              break;
            case 1:
              if (t & 1024 && u !== null) {
                t = void 0, l = e, a = u.memoizedProps, u = u.memoizedState, n = l.stateNode;
                try {
                  var G = Cn(
                    l.type,
                    a
                  );
                  t = n.getSnapshotBeforeUpdate(
                    G,
                    u
                  ), n.__reactInternalSnapshotBeforeUpdate = t;
                } catch (k) {
                  Ct(
                    l,
                    l.return,
                    k
                  );
                }
              }
              break;
            case 3:
              if (t & 1024) {
                if (t = e.stateNode.containerInfo, l = t.nodeType, l === 9)
                  Gf(t);
                else if (l === 1)
                  switch (t.nodeName) {
                    case "HEAD":
                    case "HTML":
                    case "BODY":
                      Gf(t);
                      break;
                    default:
                      t.textContent = "";
                  }
              }
              break;
            case 5:
            case 26:
            case 27:
            case 6:
            case 4:
            case 17:
              break;
            default:
              if (t & 1024) throw Error(r(163));
          }
          if (t = e.sibling, t !== null) {
            t.return = e.return, de = t;
            break;
          }
          de = e.return;
        }
  }
  function hr(t, e, l) {
    var n = l.flags;
    switch (l.tag) {
      case 0:
      case 11:
      case 15:
        Dl(t, l), n & 4 && eu(5, l);
        break;
      case 1:
        if (Dl(t, l), n & 4)
          if (t = l.stateNode, e === null)
            try {
              t.componentDidMount();
            } catch (i) {
              Ct(l, l.return, i);
            }
          else {
            var a = Cn(
              l.type,
              e.memoizedProps
            );
            e = e.memoizedState;
            try {
              t.componentDidUpdate(
                a,
                e,
                t.__reactInternalSnapshotBeforeUpdate
              );
            } catch (i) {
              Ct(
                l,
                l.return,
                i
              );
            }
          }
        n & 64 && sr(l), n & 512 && lu(l, l.return);
        break;
      case 3:
        if (Dl(t, l), n & 64 && (t = l.updateQueue, t !== null)) {
          if (e = null, l.child !== null)
            switch (l.child.tag) {
              case 27:
              case 5:
                e = l.child.stateNode;
                break;
              case 1:
                e = l.child.stateNode;
            }
          try {
            Fs(t, e);
          } catch (i) {
            Ct(l, l.return, i);
          }
        }
        break;
      case 27:
        e === null && n & 4 && gr(l);
      case 26:
      case 5:
        Dl(t, l), e === null && n & 4 && rr(l), n & 512 && lu(l, l.return);
        break;
      case 12:
        Dl(t, l);
        break;
      case 31:
        Dl(t, l), n & 4 && vr(t, l);
        break;
      case 13:
        Dl(t, l), n & 4 && Er(t, l), n & 64 && (t = l.memoizedState, t !== null && (t = t.dehydrated, t !== null && (l = Em.bind(
          null,
          l
        ), Ym(t, l))));
        break;
      case 22:
        if (n = l.memoizedState !== null || Rl, !n) {
          e = e !== null && e.memoizedState !== null || se, a = Rl;
          var u = se;
          Rl = n, (se = e) && !u ? Cl(
            t,
            l,
            (l.subtreeFlags & 8772) !== 0
          ) : Dl(t, l), Rl = a, se = u;
        }
        break;
      case 30:
        break;
      default:
        Dl(t, l);
    }
  }
  function br(t) {
    var e = t.alternate;
    e !== null && (t.alternate = null, br(e)), t.child = null, t.deletions = null, t.sibling = null, t.tag === 5 && (e = t.stateNode, e !== null && Na(e)), t.stateNode = null, t.return = null, t.dependencies = null, t.memoizedProps = null, t.memoizedState = null, t.pendingProps = null, t.stateNode = null, t.updateQueue = null;
  }
  var Vt = null, Ue = !1;
  function zl(t, e, l) {
    for (l = l.child; l !== null; )
      yr(t, e, l), l = l.sibling;
  }
  function yr(t, e, l) {
    if (Se && typeof Se.onCommitFiberUnmount == "function")
      try {
        Se.onCommitFiberUnmount(dn, l);
      } catch {
      }
    switch (l.tag) {
      case 26:
        se || rl(l, e), zl(
          t,
          e,
          l
        ), l.memoizedState ? l.memoizedState.count-- : l.stateNode && (l = l.stateNode, l.parentNode.removeChild(l));
        break;
      case 27:
        se || rl(l, e);
        var n = Vt, a = Ue;
        nn(l.type) && (Vt = l.stateNode, Ue = !1), zl(
          t,
          e,
          l
        ), ru(l.stateNode), Vt = n, Ue = a;
        break;
      case 5:
        se || rl(l, e);
      case 6:
        if (n = Vt, a = Ue, Vt = null, zl(
          t,
          e,
          l
        ), Vt = n, Ue = a, Vt !== null)
          if (Ue)
            try {
              (Vt.nodeType === 9 ? Vt.body : Vt.nodeName === "HTML" ? Vt.ownerDocument.body : Vt).removeChild(l.stateNode);
            } catch (u) {
              Ct(
                l,
                e,
                u
              );
            }
          else
            try {
              Vt.removeChild(l.stateNode);
            } catch (u) {
              Ct(
                l,
                e,
                u
              );
            }
        break;
      case 18:
        Vt !== null && (Ue ? (t = Vt, sd(
          t.nodeType === 9 ? t.body : t.nodeName === "HTML" ? t.ownerDocument.body : t,
          l.stateNode
        ), va(t)) : sd(Vt, l.stateNode));
        break;
      case 4:
        n = Vt, a = Ue, Vt = l.stateNode.containerInfo, Ue = !0, zl(
          t,
          e,
          l
        ), Vt = n, Ue = a;
        break;
      case 0:
      case 11:
      case 14:
      case 15:
        Wl(2, l, e), se || Wl(4, l, e), zl(
          t,
          e,
          l
        );
        break;
      case 1:
        se || (rl(l, e), n = l.stateNode, typeof n.componentWillUnmount == "function" && or(
          l,
          e,
          n
        )), zl(
          t,
          e,
          l
        );
        break;
      case 21:
        zl(
          t,
          e,
          l
        );
        break;
      case 22:
        se = (n = se) || l.memoizedState !== null, zl(
          t,
          e,
          l
        ), se = n;
        break;
      default:
        zl(
          t,
          e,
          l
        );
    }
  }
  function vr(t, e) {
    if (e.memoizedState === null && (t = e.alternate, t !== null && (t = t.memoizedState, t !== null))) {
      t = t.dehydrated;
      try {
        va(t);
      } catch (l) {
        Ct(e, e.return, l);
      }
    }
  }
  function Er(t, e) {
    if (e.memoizedState === null && (t = e.alternate, t !== null && (t = t.memoizedState, t !== null && (t = t.dehydrated, t !== null))))
      try {
        va(t);
      } catch (l) {
        Ct(e, e.return, l);
      }
  }
  function rm(t) {
    switch (t.tag) {
      case 31:
      case 13:
      case 19:
        var e = t.stateNode;
        return e === null && (e = t.stateNode = new mr()), e;
      case 22:
        return t = t.stateNode, e = t._retryCache, e === null && (e = t._retryCache = new mr()), e;
      default:
        throw Error(r(435, t.tag));
    }
  }
  function mi(t, e) {
    var l = rm(t);
    e.forEach(function(n) {
      if (!l.has(n)) {
        l.add(n);
        var a = pm.bind(null, t, n);
        n.then(a, a);
      }
    });
  }
  function xe(t, e) {
    var l = e.deletions;
    if (l !== null)
      for (var n = 0; n < l.length; n++) {
        var a = l[n], u = t, i = e, c = i;
        t: for (; c !== null; ) {
          switch (c.tag) {
            case 27:
              if (nn(c.type)) {
                Vt = c.stateNode, Ue = !1;
                break t;
              }
              break;
            case 5:
              Vt = c.stateNode, Ue = !1;
              break t;
            case 3:
            case 4:
              Vt = c.stateNode.containerInfo, Ue = !0;
              break t;
          }
          c = c.return;
        }
        if (Vt === null) throw Error(r(160));
        yr(u, i, a), Vt = null, Ue = !1, u = a.alternate, u !== null && (u.return = null), a.return = null;
      }
    if (e.subtreeFlags & 13886)
      for (e = e.child; e !== null; )
        pr(e, t), e = e.sibling;
  }
  var al = null;
  function pr(t, e) {
    var l = t.alternate, n = t.flags;
    switch (t.tag) {
      case 0:
      case 11:
      case 14:
      case 15:
        xe(e, t), Be(t), n & 4 && (Wl(3, t, t.return), eu(3, t), Wl(5, t, t.return));
        break;
      case 1:
        xe(e, t), Be(t), n & 512 && (se || l === null || rl(l, l.return)), n & 64 && Rl && (t = t.updateQueue, t !== null && (n = t.callbacks, n !== null && (l = t.shared.hiddenCallbacks, t.shared.hiddenCallbacks = l === null ? n : l.concat(n))));
        break;
      case 26:
        var a = al;
        if (xe(e, t), Be(t), n & 512 && (se || l === null || rl(l, l.return)), n & 4) {
          var u = l !== null ? l.memoizedState : null;
          if (n = t.memoizedState, l === null)
            if (n === null)
              if (t.stateNode === null) {
                t: {
                  n = t.type, l = t.memoizedProps, a = a.ownerDocument || a;
                  e: switch (n) {
                    case "title":
                      u = a.getElementsByTagName("title")[0], (!u || u[hn] || u[Pt] || u.namespaceURI === "http://www.w3.org/2000/svg" || u.hasAttribute("itemprop")) && (u = a.createElement(n), a.head.insertBefore(
                        u,
                        a.querySelector("head > title")
                      )), pe(u, n, l), u[Pt] = t, ae(u), n = u;
                      break t;
                    case "link":
                      var i = pd(
                        "link",
                        "href",
                        a
                      ).get(n + (l.href || ""));
                      if (i) {
                        for (var c = 0; c < i.length; c++)
                          if (u = i[c], u.getAttribute("href") === (l.href == null || l.href === "" ? null : l.href) && u.getAttribute("rel") === (l.rel == null ? null : l.rel) && u.getAttribute("title") === (l.title == null ? null : l.title) && u.getAttribute("crossorigin") === (l.crossOrigin == null ? null : l.crossOrigin)) {
                            i.splice(c, 1);
                            break e;
                          }
                      }
                      u = a.createElement(n), pe(u, n, l), a.head.appendChild(u);
                      break;
                    case "meta":
                      if (i = pd(
                        "meta",
                        "content",
                        a
                      ).get(n + (l.content || ""))) {
                        for (c = 0; c < i.length; c++)
                          if (u = i[c], u.getAttribute("content") === (l.content == null ? null : "" + l.content) && u.getAttribute("name") === (l.name == null ? null : l.name) && u.getAttribute("property") === (l.property == null ? null : l.property) && u.getAttribute("http-equiv") === (l.httpEquiv == null ? null : l.httpEquiv) && u.getAttribute("charset") === (l.charSet == null ? null : l.charSet)) {
                            i.splice(c, 1);
                            break e;
                          }
                      }
                      u = a.createElement(n), pe(u, n, l), a.head.appendChild(u);
                      break;
                    default:
                      throw Error(r(468, n));
                  }
                  u[Pt] = t, ae(u), n = u;
                }
                t.stateNode = n;
              } else
                Sd(
                  a,
                  t.type,
                  t.stateNode
                );
            else
              t.stateNode = Ed(
                a,
                n,
                t.memoizedProps
              );
          else
            u !== n ? (u === null ? l.stateNode !== null && (l = l.stateNode, l.parentNode.removeChild(l)) : u.count--, n === null ? Sd(
              a,
              t.type,
              t.stateNode
            ) : Ed(
              a,
              n,
              t.memoizedProps
            )) : n === null && t.stateNode !== null && sf(
              t,
              t.memoizedProps,
              l.memoizedProps
            );
        }
        break;
      case 27:
        xe(e, t), Be(t), n & 512 && (se || l === null || rl(l, l.return)), l !== null && n & 4 && sf(
          t,
          t.memoizedProps,
          l.memoizedProps
        );
        break;
      case 5:
        if (xe(e, t), Be(t), n & 512 && (se || l === null || rl(l, l.return)), t.flags & 32) {
          a = t.stateNode;
          try {
            $(a, "");
          } catch (G) {
            Ct(t, t.return, G);
          }
        }
        n & 4 && t.stateNode != null && (a = t.memoizedProps, sf(
          t,
          a,
          l !== null ? l.memoizedProps : a
        )), n & 1024 && (df = !0);
        break;
      case 6:
        if (xe(e, t), Be(t), n & 4) {
          if (t.stateNode === null)
            throw Error(r(162));
          n = t.memoizedProps, l = t.stateNode;
          try {
            l.nodeValue = n;
          } catch (G) {
            Ct(t, t.return, G);
          }
        }
        break;
      case 3:
        if (Di = null, a = al, al = Ri(e.containerInfo), xe(e, t), al = a, Be(t), n & 4 && l !== null && l.memoizedState.isDehydrated)
          try {
            va(e.containerInfo);
          } catch (G) {
            Ct(t, t.return, G);
          }
        df && (df = !1, Sr(t));
        break;
      case 4:
        n = al, al = Ri(
          t.stateNode.containerInfo
        ), xe(e, t), Be(t), al = n;
        break;
      case 12:
        xe(e, t), Be(t);
        break;
      case 31:
        xe(e, t), Be(t), n & 4 && (n = t.updateQueue, n !== null && (t.updateQueue = null, mi(t, n)));
        break;
      case 13:
        xe(e, t), Be(t), t.child.flags & 8192 && t.memoizedState !== null != (l !== null && l.memoizedState !== null) && (bi = It()), n & 4 && (n = t.updateQueue, n !== null && (t.updateQueue = null, mi(t, n)));
        break;
      case 22:
        a = t.memoizedState !== null;
        var f = l !== null && l.memoizedState !== null, b = Rl, S = se;
        if (Rl = b || a, se = S || f, xe(e, t), se = S, Rl = b, Be(t), n & 8192)
          t: for (e = t.stateNode, e._visibility = a ? e._visibility & -2 : e._visibility | 1, a && (l === null || f || Rl || se || Un(t)), l = null, e = t; ; ) {
            if (e.tag === 5 || e.tag === 26) {
              if (l === null) {
                f = l = e;
                try {
                  if (u = f.stateNode, a)
                    i = u.style, typeof i.setProperty == "function" ? i.setProperty("display", "none", "important") : i.display = "none";
                  else {
                    c = f.stateNode;
                    var O = f.memoizedProps.style, y = O != null && O.hasOwnProperty("display") ? O.display : null;
                    c.style.display = y == null || typeof y == "boolean" ? "" : ("" + y).trim();
                  }
                } catch (G) {
                  Ct(f, f.return, G);
                }
              }
            } else if (e.tag === 6) {
              if (l === null) {
                f = e;
                try {
                  f.stateNode.nodeValue = a ? "" : f.memoizedProps;
                } catch (G) {
                  Ct(f, f.return, G);
                }
              }
            } else if (e.tag === 18) {
              if (l === null) {
                f = e;
                try {
                  var v = f.stateNode;
                  a ? od(v, !0) : od(f.stateNode, !1);
                } catch (G) {
                  Ct(f, f.return, G);
                }
              }
            } else if ((e.tag !== 22 && e.tag !== 23 || e.memoizedState === null || e === t) && e.child !== null) {
              e.child.return = e, e = e.child;
              continue;
            }
            if (e === t) break t;
            for (; e.sibling === null; ) {
              if (e.return === null || e.return === t) break t;
              l === e && (l = null), e = e.return;
            }
            l === e && (l = null), e.sibling.return = e.return, e = e.sibling;
          }
        n & 4 && (n = t.updateQueue, n !== null && (l = n.retryQueue, l !== null && (n.retryQueue = null, mi(t, l))));
        break;
      case 19:
        xe(e, t), Be(t), n & 4 && (n = t.updateQueue, n !== null && (t.updateQueue = null, mi(t, n)));
        break;
      case 30:
        break;
      case 21:
        break;
      default:
        xe(e, t), Be(t);
    }
  }
  function Be(t) {
    var e = t.flags;
    if (e & 2) {
      try {
        for (var l, n = t.return; n !== null; ) {
          if (dr(n)) {
            l = n;
            break;
          }
          n = n.return;
        }
        if (l == null) throw Error(r(160));
        switch (l.tag) {
          case 27:
            var a = l.stateNode, u = of(t);
            gi(t, u, a);
            break;
          case 5:
            var i = l.stateNode;
            l.flags & 32 && ($(i, ""), l.flags &= -33);
            var c = of(t);
            gi(t, c, i);
            break;
          case 3:
          case 4:
            var f = l.stateNode.containerInfo, b = of(t);
            rf(
              t,
              b,
              f
            );
            break;
          default:
            throw Error(r(161));
        }
      } catch (S) {
        Ct(t, t.return, S);
      }
      t.flags &= -3;
    }
    e & 4096 && (t.flags &= -4097);
  }
  function Sr(t) {
    if (t.subtreeFlags & 1024)
      for (t = t.child; t !== null; ) {
        var e = t;
        Sr(e), e.tag === 5 && e.flags & 1024 && e.stateNode.reset(), t = t.sibling;
      }
  }
  function Dl(t, e) {
    if (e.subtreeFlags & 8772)
      for (e = e.child; e !== null; )
        hr(t, e.alternate, e), e = e.sibling;
  }
  function Un(t) {
    for (t = t.child; t !== null; ) {
      var e = t;
      switch (e.tag) {
        case 0:
        case 11:
        case 14:
        case 15:
          Wl(4, e, e.return), Un(e);
          break;
        case 1:
          rl(e, e.return);
          var l = e.stateNode;
          typeof l.componentWillUnmount == "function" && or(
            e,
            e.return,
            l
          ), Un(e);
          break;
        case 27:
          ru(e.stateNode);
        case 26:
        case 5:
          rl(e, e.return), Un(e);
          break;
        case 22:
          e.memoizedState === null && Un(e);
          break;
        case 30:
          Un(e);
          break;
        default:
          Un(e);
      }
      t = t.sibling;
    }
  }
  function Cl(t, e, l) {
    for (l = l && (e.subtreeFlags & 8772) !== 0, e = e.child; e !== null; ) {
      var n = e.alternate, a = t, u = e, i = u.flags;
      switch (u.tag) {
        case 0:
        case 11:
        case 15:
          Cl(
            a,
            u,
            l
          ), eu(4, u);
          break;
        case 1:
          if (Cl(
            a,
            u,
            l
          ), n = u, a = n.stateNode, typeof a.componentDidMount == "function")
            try {
              a.componentDidMount();
            } catch (b) {
              Ct(n, n.return, b);
            }
          if (n = u, a = n.updateQueue, a !== null) {
            var c = n.stateNode;
            try {
              var f = a.shared.hiddenCallbacks;
              if (f !== null)
                for (a.shared.hiddenCallbacks = null, a = 0; a < f.length; a++)
                  Is(f[a], c);
            } catch (b) {
              Ct(n, n.return, b);
            }
          }
          l && i & 64 && sr(u), lu(u, u.return);
          break;
        case 27:
          gr(u);
        case 26:
        case 5:
          Cl(
            a,
            u,
            l
          ), l && n === null && i & 4 && rr(u), lu(u, u.return);
          break;
        case 12:
          Cl(
            a,
            u,
            l
          );
          break;
        case 31:
          Cl(
            a,
            u,
            l
          ), l && i & 4 && vr(a, u);
          break;
        case 13:
          Cl(
            a,
            u,
            l
          ), l && i & 4 && Er(a, u);
          break;
        case 22:
          u.memoizedState === null && Cl(
            a,
            u,
            l
          ), lu(u, u.return);
          break;
        case 30:
          break;
        default:
          Cl(
            a,
            u,
            l
          );
      }
      e = e.sibling;
    }
  }
  function gf(t, e) {
    var l = null;
    t !== null && t.memoizedState !== null && t.memoizedState.cachePool !== null && (l = t.memoizedState.cachePool.pool), t = null, e.memoizedState !== null && e.memoizedState.cachePool !== null && (t = e.memoizedState.cachePool.pool), t !== l && (t != null && t.refCount++, l != null && Za(l));
  }
  function mf(t, e) {
    t = null, e.alternate !== null && (t = e.alternate.memoizedState.cache), e = e.memoizedState.cache, e !== t && (e.refCount++, t != null && Za(t));
  }
  function ul(t, e, l, n) {
    if (e.subtreeFlags & 10256)
      for (e = e.child; e !== null; )
        _r(
          t,
          e,
          l,
          n
        ), e = e.sibling;
  }
  function _r(t, e, l, n) {
    var a = e.flags;
    switch (e.tag) {
      case 0:
      case 11:
      case 15:
        ul(
          t,
          e,
          l,
          n
        ), a & 2048 && eu(9, e);
        break;
      case 1:
        ul(
          t,
          e,
          l,
          n
        );
        break;
      case 3:
        ul(
          t,
          e,
          l,
          n
        ), a & 2048 && (t = null, e.alternate !== null && (t = e.alternate.memoizedState.cache), e = e.memoizedState.cache, e !== t && (e.refCount++, t != null && Za(t)));
        break;
      case 12:
        if (a & 2048) {
          ul(
            t,
            e,
            l,
            n
          ), t = e.stateNode;
          try {
            var u = e.memoizedProps, i = u.id, c = u.onPostCommit;
            typeof c == "function" && c(
              i,
              e.alternate === null ? "mount" : "update",
              t.passiveEffectDuration,
              -0
            );
          } catch (f) {
            Ct(e, e.return, f);
          }
        } else
          ul(
            t,
            e,
            l,
            n
          );
        break;
      case 31:
        ul(
          t,
          e,
          l,
          n
        );
        break;
      case 13:
        ul(
          t,
          e,
          l,
          n
        );
        break;
      case 23:
        break;
      case 22:
        u = e.stateNode, i = e.alternate, e.memoizedState !== null ? u._visibility & 2 ? ul(
          t,
          e,
          l,
          n
        ) : nu(t, e) : u._visibility & 2 ? ul(
          t,
          e,
          l,
          n
        ) : (u._visibility |= 2, ca(
          t,
          e,
          l,
          n,
          (e.subtreeFlags & 10256) !== 0 || !1
        )), a & 2048 && gf(i, e);
        break;
      case 24:
        ul(
          t,
          e,
          l,
          n
        ), a & 2048 && mf(e.alternate, e);
        break;
      default:
        ul(
          t,
          e,
          l,
          n
        );
    }
  }
  function ca(t, e, l, n, a) {
    for (a = a && ((e.subtreeFlags & 10256) !== 0 || !1), e = e.child; e !== null; ) {
      var u = t, i = e, c = l, f = n, b = i.flags;
      switch (i.tag) {
        case 0:
        case 11:
        case 15:
          ca(
            u,
            i,
            c,
            f,
            a
          ), eu(8, i);
          break;
        case 23:
          break;
        case 22:
          var S = i.stateNode;
          i.memoizedState !== null ? S._visibility & 2 ? ca(
            u,
            i,
            c,
            f,
            a
          ) : nu(
            u,
            i
          ) : (S._visibility |= 2, ca(
            u,
            i,
            c,
            f,
            a
          )), a && b & 2048 && gf(
            i.alternate,
            i
          );
          break;
        case 24:
          ca(
            u,
            i,
            c,
            f,
            a
          ), a && b & 2048 && mf(i.alternate, i);
          break;
        default:
          ca(
            u,
            i,
            c,
            f,
            a
          );
      }
      e = e.sibling;
    }
  }
  function nu(t, e) {
    if (e.subtreeFlags & 10256)
      for (e = e.child; e !== null; ) {
        var l = t, n = e, a = n.flags;
        switch (n.tag) {
          case 22:
            nu(l, n), a & 2048 && gf(
              n.alternate,
              n
            );
            break;
          case 24:
            nu(l, n), a & 2048 && mf(n.alternate, n);
            break;
          default:
            nu(l, n);
        }
        e = e.sibling;
      }
  }
  var au = 8192;
  function fa(t, e, l) {
    if (t.subtreeFlags & au)
      for (t = t.child; t !== null; )
        Tr(
          t,
          e,
          l
        ), t = t.sibling;
  }
  function Tr(t, e, l) {
    switch (t.tag) {
      case 26:
        fa(
          t,
          e,
          l
        ), t.flags & au && t.memoizedState !== null && Im(
          l,
          al,
          t.memoizedState,
          t.memoizedProps
        );
        break;
      case 5:
        fa(
          t,
          e,
          l
        );
        break;
      case 3:
      case 4:
        var n = al;
        al = Ri(t.stateNode.containerInfo), fa(
          t,
          e,
          l
        ), al = n;
        break;
      case 22:
        t.memoizedState === null && (n = t.alternate, n !== null && n.memoizedState !== null ? (n = au, au = 16777216, fa(
          t,
          e,
          l
        ), au = n) : fa(
          t,
          e,
          l
        ));
        break;
      default:
        fa(
          t,
          e,
          l
        );
    }
  }
  function Ar(t) {
    var e = t.alternate;
    if (e !== null && (t = e.child, t !== null)) {
      e.child = null;
      do
        e = t.sibling, t.sibling = null, t = e;
      while (t !== null);
    }
  }
  function uu(t) {
    var e = t.deletions;
    if (t.flags & 16) {
      if (e !== null)
        for (var l = 0; l < e.length; l++) {
          var n = e[l];
          de = n, Nr(
            n,
            t
          );
        }
      Ar(t);
    }
    if (t.subtreeFlags & 10256)
      for (t = t.child; t !== null; )
        Or(t), t = t.sibling;
  }
  function Or(t) {
    switch (t.tag) {
      case 0:
      case 11:
      case 15:
        uu(t), t.flags & 2048 && Wl(9, t, t.return);
        break;
      case 3:
        uu(t);
        break;
      case 12:
        uu(t);
        break;
      case 22:
        var e = t.stateNode;
        t.memoizedState !== null && e._visibility & 2 && (t.return === null || t.return.tag !== 13) ? (e._visibility &= -3, hi(t)) : uu(t);
        break;
      default:
        uu(t);
    }
  }
  function hi(t) {
    var e = t.deletions;
    if (t.flags & 16) {
      if (e !== null)
        for (var l = 0; l < e.length; l++) {
          var n = e[l];
          de = n, Nr(
            n,
            t
          );
        }
      Ar(t);
    }
    for (t = t.child; t !== null; ) {
      switch (e = t, e.tag) {
        case 0:
        case 11:
        case 15:
          Wl(8, e, e.return), hi(e);
          break;
        case 22:
          l = e.stateNode, l._visibility & 2 && (l._visibility &= -3, hi(e));
          break;
        default:
          hi(e);
      }
      t = t.sibling;
    }
  }
  function Nr(t, e) {
    for (; de !== null; ) {
      var l = de;
      switch (l.tag) {
        case 0:
        case 11:
        case 15:
          Wl(8, l, e);
          break;
        case 23:
        case 22:
          if (l.memoizedState !== null && l.memoizedState.cachePool !== null) {
            var n = l.memoizedState.cachePool.pool;
            n != null && n.refCount++;
          }
          break;
        case 24:
          Za(l.memoizedState.cache);
      }
      if (n = l.child, n !== null) n.return = l, de = n;
      else
        t: for (l = t; de !== null; ) {
          n = de;
          var a = n.sibling, u = n.return;
          if (br(n), n === l) {
            de = null;
            break t;
          }
          if (a !== null) {
            a.return = u, de = a;
            break t;
          }
          de = u;
        }
    }
  }
  var dm = {
    getCacheForType: function(t) {
      var e = ve(ie), l = e.data.get(t);
      return l === void 0 && (l = t(), e.data.set(t, l)), l;
    },
    cacheSignal: function() {
      return ve(ie).controller.signal;
    }
  }, gm = typeof WeakMap == "function" ? WeakMap : Map, Ot = 0, Gt = null, gt = null, yt = 0, Dt = 0, Ke = null, Il = !1, sa = !1, hf = !1, Ul = 0, Wt = 0, Fl = 0, xn = 0, bf = 0, Ve = 0, oa = 0, iu = null, He = null, yf = !1, bi = 0, Mr = 0, yi = 1 / 0, vi = null, Pl = null, re = 0, tn = null, ra = null, xl = 0, vf = 0, Ef = null, Rr = null, cu = 0, pf = null;
  function ke() {
    return Ot & 2 && yt !== 0 ? yt & -yt : p.T !== null ? Nf() : Gn();
  }
  function zr() {
    if (Ve === 0)
      if (!(yt & 536870912) || Et) {
        var t = Ln;
        Ln <<= 1, !(Ln & 3932160) && (Ln = 262144), Ve = t;
      } else Ve = 536870912;
    return t = je.current, t !== null && (t.flags |= 32), Ve;
  }
  function Le(t, e, l) {
    (t === Gt && (Dt === 2 || Dt === 9) || t.cancelPendingCommit !== null) && (da(t, 0), en(
      t,
      yt,
      Ve,
      !1
    )), Lt(t, l), (!(Ot & 2) || t !== Gt) && (t === Gt && (!(Ot & 2) && (xn |= l), Wt === 4 && en(
      t,
      yt,
      Ve,
      !1
    )), dl(t));
  }
  function Dr(t, e, l) {
    if (Ot & 6) throw Error(r(327));
    var n = !l && (e & 127) === 0 && (e & t.expiredLanes) === 0 || T(t, e), a = n ? bm(t, e) : _f(t, e, !0), u = n;
    do {
      if (a === 0) {
        sa && !n && en(t, e, 0, !1);
        break;
      } else {
        if (l = t.current.alternate, u && !mm(l)) {
          a = _f(t, e, !1), u = !1;
          continue;
        }
        if (a === 2) {
          if (u = e, t.errorRecoveryDisabledLanes & u)
            var i = 0;
          else
            i = t.pendingLanes & -536870913, i = i !== 0 ? i : i & 536870912 ? 536870912 : 0;
          if (i !== 0) {
            e = i;
            t: {
              var c = t;
              a = iu;
              var f = c.current.memoizedState.isDehydrated;
              if (f && (da(c, i).flags |= 256), i = _f(
                c,
                i,
                !1
              ), i !== 2) {
                if (hf && !f) {
                  c.errorRecoveryDisabledLanes |= u, xn |= u, a = 4;
                  break t;
                }
                u = He, He = a, u !== null && (He === null ? He = u : He.push.apply(
                  He,
                  u
                ));
              }
              a = i;
            }
            if (u = !1, a !== 2) continue;
          }
        }
        if (a === 1) {
          da(t, 0), en(t, e, 0, !0);
          break;
        }
        t: {
          switch (n = t, u = a, u) {
            case 0:
            case 1:
              throw Error(r(345));
            case 4:
              if ((e & 4194048) !== e) break;
            case 6:
              en(
                n,
                e,
                Ve,
                !Il
              );
              break t;
            case 2:
              He = null;
              break;
            case 3:
            case 5:
              break;
            default:
              throw Error(r(329));
          }
          if ((e & 62914560) === e && (a = bi + 300 - It(), 10 < a)) {
            if (en(
              n,
              e,
              Ve,
              !Il
            ), s(n, 0, !0) !== 0) break t;
            xl = e, n.timeoutHandle = cd(
              Cr.bind(
                null,
                n,
                l,
                He,
                vi,
                yf,
                e,
                Ve,
                xn,
                oa,
                Il,
                u,
                "Throttled",
                -0,
                0
              ),
              a
            );
            break t;
          }
          Cr(
            n,
            l,
            He,
            vi,
            yf,
            e,
            Ve,
            xn,
            oa,
            Il,
            u,
            null,
            -0,
            0
          );
        }
      }
      break;
    } while (!0);
    dl(t);
  }
  function Cr(t, e, l, n, a, u, i, c, f, b, S, O, y, v) {
    if (t.timeoutHandle = -1, O = e.subtreeFlags, O & 8192 || (O & 16785408) === 16785408) {
      O = {
        stylesheets: null,
        count: 0,
        imgCount: 0,
        imgBytes: 0,
        suspenseyImages: [],
        waitingForImages: !0,
        waitingForViewTransition: !1,
        unsuspend: D
      }, Tr(
        e,
        u,
        O
      );
      var G = (u & 62914560) === u ? bi - It() : (u & 4194048) === u ? Mr - It() : 0;
      if (G = Fm(
        O,
        G
      ), G !== null) {
        xl = u, t.cancelPendingCommit = G(
          Yr.bind(
            null,
            t,
            e,
            u,
            l,
            n,
            a,
            i,
            c,
            f,
            S,
            O,
            null,
            y,
            v
          )
        ), en(t, u, i, !b);
        return;
      }
    }
    Yr(
      t,
      e,
      u,
      l,
      n,
      a,
      i,
      c,
      f
    );
  }
  function mm(t) {
    for (var e = t; ; ) {
      var l = e.tag;
      if ((l === 0 || l === 11 || l === 15) && e.flags & 16384 && (l = e.updateQueue, l !== null && (l = l.stores, l !== null)))
        for (var n = 0; n < l.length; n++) {
          var a = l[n], u = a.getSnapshot;
          a = a.value;
          try {
            if (!Xe(u(), a)) return !1;
          } catch {
            return !1;
          }
        }
      if (l = e.child, e.subtreeFlags & 16384 && l !== null)
        l.return = e, e = l;
      else {
        if (e === t) break;
        for (; e.sibling === null; ) {
          if (e.return === null || e.return === t) return !0;
          e = e.return;
        }
        e.sibling.return = e.return, e = e.sibling;
      }
    }
    return !0;
  }
  function en(t, e, l, n) {
    e &= ~bf, e &= ~xn, t.suspendedLanes |= e, t.pingedLanes &= ~e, n && (t.warmLanes |= e), n = t.expirationTimes;
    for (var a = e; 0 < a; ) {
      var u = 31 - Oe(a), i = 1 << u;
      n[u] = -1, a &= ~i;
    }
    l !== 0 && L(t, l, e);
  }
  function Ei() {
    return Ot & 6 ? !0 : (fu(0), !1);
  }
  function Sf() {
    if (gt !== null) {
      if (Dt === 0)
        var t = gt.return;
      else
        t = gt, _l = An = null, Lc(t), la = null, Qa = 0, t = gt;
      for (; t !== null; )
        fr(t.alternate, t), t = t.return;
      gt = null;
    }
  }
  function da(t, e) {
    var l = t.timeoutHandle;
    l !== -1 && (t.timeoutHandle = -1, Bm(l)), l = t.cancelPendingCommit, l !== null && (t.cancelPendingCommit = null, l()), xl = 0, Sf(), Gt = t, gt = l = pl(t.current, null), yt = e, Dt = 0, Ke = null, Il = !1, sa = T(t, e), hf = !1, oa = Ve = bf = xn = Fl = Wt = 0, He = iu = null, yf = !1, e & 8 && (e |= e & 32);
    var n = t.entangledLanes;
    if (n !== 0)
      for (t = t.entanglements, n &= e; 0 < n; ) {
        var a = 31 - Oe(n), u = 1 << a;
        e |= t[a], n &= ~u;
      }
    return Ul = e, wu(), l;
  }
  function Ur(t, e) {
    ct = null, p.H = Fa, e === ea || e === Ju ? (e = ks(), Dt = 3) : e === Ac ? (e = ks(), Dt = 4) : Dt = e === Fc ? 8 : e !== null && typeof e == "object" && typeof e.then == "function" ? 6 : 1, Ke = e, gt === null && (Wt = 1, fi(
      t,
      We(e, t.current)
    ));
  }
  function xr() {
    var t = je.current;
    return t === null ? !0 : (yt & 4194048) === yt ? tl === null : (yt & 62914560) === yt || yt & 536870912 ? t === tl : !1;
  }
  function Br() {
    var t = p.H;
    return p.H = Fa, t === null ? Fa : t;
  }
  function Hr() {
    var t = p.A;
    return p.A = dm, t;
  }
  function pi() {
    Wt = 4, Il || (yt & 4194048) !== yt && je.current !== null || (sa = !0), !(Fl & 134217727) && !(xn & 134217727) || Gt === null || en(
      Gt,
      yt,
      Ve,
      !1
    );
  }
  function _f(t, e, l) {
    var n = Ot;
    Ot |= 2;
    var a = Br(), u = Hr();
    (Gt !== t || yt !== e) && (vi = null, da(t, e)), e = !1;
    var i = Wt;
    t: do
      try {
        if (Dt !== 0 && gt !== null) {
          var c = gt, f = Ke;
          switch (Dt) {
            case 8:
              Sf(), i = 6;
              break t;
            case 3:
            case 2:
            case 9:
            case 6:
              je.current === null && (e = !0);
              var b = Dt;
              if (Dt = 0, Ke = null, ga(t, c, f, b), l && sa) {
                i = 0;
                break t;
              }
              break;
            default:
              b = Dt, Dt = 0, Ke = null, ga(t, c, f, b);
          }
        }
        hm(), i = Wt;
        break;
      } catch (S) {
        Ur(t, S);
      }
    while (!0);
    return e && t.shellSuspendCounter++, _l = An = null, Ot = n, p.H = a, p.A = u, gt === null && (Gt = null, yt = 0, wu()), i;
  }
  function hm() {
    for (; gt !== null; ) Lr(gt);
  }
  function bm(t, e) {
    var l = Ot;
    Ot |= 2;
    var n = Br(), a = Hr();
    Gt !== t || yt !== e ? (vi = null, yi = It() + 500, da(t, e)) : sa = T(
      t,
      e
    );
    t: do
      try {
        if (Dt !== 0 && gt !== null) {
          e = gt;
          var u = Ke;
          e: switch (Dt) {
            case 1:
              Dt = 0, Ke = null, ga(t, e, u, 1);
              break;
            case 2:
            case 9:
              if (Ks(u)) {
                Dt = 0, Ke = null, Gr(e);
                break;
              }
              e = function() {
                Dt !== 2 && Dt !== 9 || Gt !== t || (Dt = 7), dl(t);
              }, u.then(e, e);
              break t;
            case 3:
              Dt = 7;
              break t;
            case 4:
              Dt = 5;
              break t;
            case 7:
              Ks(u) ? (Dt = 0, Ke = null, Gr(e)) : (Dt = 0, Ke = null, ga(t, e, u, 7));
              break;
            case 5:
              var i = null;
              switch (gt.tag) {
                case 26:
                  i = gt.memoizedState;
                case 5:
                case 27:
                  var c = gt;
                  if (i ? _d(i) : c.stateNode.complete) {
                    Dt = 0, Ke = null;
                    var f = c.sibling;
                    if (f !== null) gt = f;
                    else {
                      var b = c.return;
                      b !== null ? (gt = b, Si(b)) : gt = null;
                    }
                    break e;
                  }
              }
              Dt = 0, Ke = null, ga(t, e, u, 5);
              break;
            case 6:
              Dt = 0, Ke = null, ga(t, e, u, 6);
              break;
            case 8:
              Sf(), Wt = 6;
              break t;
            default:
              throw Error(r(462));
          }
        }
        ym();
        break;
      } catch (S) {
        Ur(t, S);
      }
    while (!0);
    return _l = An = null, p.H = n, p.A = a, Ot = l, gt !== null ? 0 : (Gt = null, yt = 0, wu(), Wt);
  }
  function ym() {
    for (; gt !== null && !ji(); )
      Lr(gt);
  }
  function Lr(t) {
    var e = ir(t.alternate, t, Ul);
    t.memoizedProps = t.pendingProps, e === null ? Si(t) : gt = e;
  }
  function Gr(t) {
    var e = t, l = e.alternate;
    switch (e.tag) {
      case 15:
      case 0:
        e = tr(
          l,
          e,
          e.pendingProps,
          e.type,
          void 0,
          yt
        );
        break;
      case 11:
        e = tr(
          l,
          e,
          e.pendingProps,
          e.type.render,
          e.ref,
          yt
        );
        break;
      case 5:
        Lc(e);
      default:
        fr(l, e), e = gt = Bs(e, Ul), e = ir(l, e, Ul);
    }
    t.memoizedProps = t.pendingProps, e === null ? Si(t) : gt = e;
  }
  function ga(t, e, l, n) {
    _l = An = null, Lc(e), la = null, Qa = 0;
    var a = e.return;
    try {
      if (um(
        t,
        a,
        e,
        l,
        yt
      )) {
        Wt = 1, fi(
          t,
          We(l, t.current)
        ), gt = null;
        return;
      }
    } catch (u) {
      if (a !== null) throw gt = a, u;
      Wt = 1, fi(
        t,
        We(l, t.current)
      ), gt = null;
      return;
    }
    e.flags & 32768 ? (Et || n === 1 ? t = !0 : sa || yt & 536870912 ? t = !1 : (Il = t = !0, (n === 2 || n === 9 || n === 3 || n === 6) && (n = je.current, n !== null && n.tag === 13 && (n.flags |= 16384))), qr(e, t)) : Si(e);
  }
  function Si(t) {
    var e = t;
    do {
      if (e.flags & 32768) {
        qr(
          e,
          Il
        );
        return;
      }
      t = e.return;
      var l = fm(
        e.alternate,
        e,
        Ul
      );
      if (l !== null) {
        gt = l;
        return;
      }
      if (e = e.sibling, e !== null) {
        gt = e;
        return;
      }
      gt = e = t;
    } while (e !== null);
    Wt === 0 && (Wt = 5);
  }
  function qr(t, e) {
    do {
      var l = sm(t.alternate, t);
      if (l !== null) {
        l.flags &= 32767, gt = l;
        return;
      }
      if (l = t.return, l !== null && (l.flags |= 32768, l.subtreeFlags = 0, l.deletions = null), !e && (t = t.sibling, t !== null)) {
        gt = t;
        return;
      }
      gt = t = l;
    } while (t !== null);
    Wt = 6, gt = null;
  }
  function Yr(t, e, l, n, a, u, i, c, f) {
    t.cancelPendingCommit = null;
    do
      _i();
    while (re !== 0);
    if (Ot & 6) throw Error(r(327));
    if (e !== null) {
      if (e === t.current) throw Error(r(177));
      if (u = e.lanes | e.childLanes, u |= sc, Y(
        t,
        l,
        u,
        i,
        c,
        f
      ), t === Gt && (gt = Gt = null, yt = 0), ra = e, tn = t, xl = l, vf = u, Ef = a, Rr = n, e.subtreeFlags & 10256 || e.flags & 10256 ? (t.callbackNode = null, t.callbackPriority = 0, Sm(rn, function() {
        return Qr(), null;
      })) : (t.callbackNode = null, t.callbackPriority = 0), n = (e.flags & 13878) !== 0, e.subtreeFlags & 13878 || n) {
        n = p.T, p.T = null, a = U.p, U.p = 2, i = Ot, Ot |= 4;
        try {
          om(t, e, l);
        } finally {
          Ot = i, U.p = a, p.T = n;
        }
      }
      re = 1, wr(), Xr(), Zr();
    }
  }
  function wr() {
    if (re === 1) {
      re = 0;
      var t = tn, e = ra, l = (e.flags & 13878) !== 0;
      if (e.subtreeFlags & 13878 || l) {
        l = p.T, p.T = null;
        var n = U.p;
        U.p = 2;
        var a = Ot;
        Ot |= 4;
        try {
          pr(e, t);
          var u = Bf, i = Os(t.containerInfo), c = u.focusedElem, f = u.selectionRange;
          if (i !== c && c && c.ownerDocument && As(
            c.ownerDocument.documentElement,
            c
          )) {
            if (f !== null && ac(c)) {
              var b = f.start, S = f.end;
              if (S === void 0 && (S = b), "selectionStart" in c)
                c.selectionStart = b, c.selectionEnd = Math.min(
                  S,
                  c.value.length
                );
              else {
                var O = c.ownerDocument || document, y = O && O.defaultView || window;
                if (y.getSelection) {
                  var v = y.getSelection(), G = c.textContent.length, k = Math.min(f.start, G), Bt = f.end === void 0 ? k : Math.min(f.end, G);
                  !v.extend && k > Bt && (i = Bt, Bt = k, k = i);
                  var m = Ts(
                    c,
                    k
                  ), d = Ts(
                    c,
                    Bt
                  );
                  if (m && d && (v.rangeCount !== 1 || v.anchorNode !== m.node || v.anchorOffset !== m.offset || v.focusNode !== d.node || v.focusOffset !== d.offset)) {
                    var h = O.createRange();
                    h.setStart(m.node, m.offset), v.removeAllRanges(), k > Bt ? (v.addRange(h), v.extend(d.node, d.offset)) : (h.setEnd(d.node, d.offset), v.addRange(h));
                  }
                }
              }
            }
            for (O = [], v = c; v = v.parentNode; )
              v.nodeType === 1 && O.push({
                element: v,
                left: v.scrollLeft,
                top: v.scrollTop
              });
            for (typeof c.focus == "function" && c.focus(), c = 0; c < O.length; c++) {
              var A = O[c];
              A.element.scrollLeft = A.left, A.element.scrollTop = A.top;
            }
          }
          Bi = !!xf, Bf = xf = null;
        } finally {
          Ot = a, U.p = n, p.T = l;
        }
      }
      t.current = e, re = 2;
    }
  }
  function Xr() {
    if (re === 2) {
      re = 0;
      var t = tn, e = ra, l = (e.flags & 8772) !== 0;
      if (e.subtreeFlags & 8772 || l) {
        l = p.T, p.T = null;
        var n = U.p;
        U.p = 2;
        var a = Ot;
        Ot |= 4;
        try {
          hr(t, e.alternate, e);
        } finally {
          Ot = a, U.p = n, p.T = l;
        }
      }
      re = 3;
    }
  }
  function Zr() {
    if (re === 4 || re === 3) {
      re = 0, _u();
      var t = tn, e = ra, l = xl, n = Rr;
      e.subtreeFlags & 10256 || e.flags & 10256 ? re = 5 : (re = 0, ra = tn = null, jr(t, t.pendingLanes));
      var a = t.pendingLanes;
      if (a === 0 && (Pl = null), hl(l), e = e.stateNode, Se && typeof Se.onCommitFiberRoot == "function")
        try {
          Se.onCommitFiberRoot(
            dn,
            e,
            void 0,
            (e.current.flags & 128) === 128
          );
        } catch {
        }
      if (n !== null) {
        e = p.T, a = U.p, U.p = 2, p.T = null;
        try {
          for (var u = t.onRecoverableError, i = 0; i < n.length; i++) {
            var c = n[i];
            u(c.value, {
              componentStack: c.stack
            });
          }
        } finally {
          p.T = e, U.p = a;
        }
      }
      xl & 3 && _i(), dl(t), a = t.pendingLanes, l & 261930 && a & 42 ? t === pf ? cu++ : (cu = 0, pf = t) : cu = 0, fu(0);
    }
  }
  function jr(t, e) {
    (t.pooledCacheLanes &= e) === 0 && (e = t.pooledCache, e != null && (t.pooledCache = null, Za(e)));
  }
  function _i() {
    return wr(), Xr(), Zr(), Qr();
  }
  function Qr() {
    if (re !== 5) return !1;
    var t = tn, e = vf;
    vf = 0;
    var l = hl(xl), n = p.T, a = U.p;
    try {
      U.p = 32 > l ? 32 : l, p.T = null, l = Ef, Ef = null;
      var u = tn, i = xl;
      if (re = 0, ra = tn = null, xl = 0, Ot & 6) throw Error(r(331));
      var c = Ot;
      if (Ot |= 4, Or(u.current), _r(
        u,
        u.current,
        i,
        l
      ), Ot = c, fu(0, !1), Se && typeof Se.onPostCommitFiberRoot == "function")
        try {
          Se.onPostCommitFiberRoot(dn, u);
        } catch {
        }
      return !0;
    } finally {
      U.p = a, p.T = n, jr(t, e);
    }
  }
  function Kr(t, e, l) {
    e = We(l, e), e = Ic(t.stateNode, e, 2), t = kl(t, e, 2), t !== null && (Lt(t, 2), dl(t));
  }
  function Ct(t, e, l) {
    if (t.tag === 3)
      Kr(t, t, l);
    else
      for (; e !== null; ) {
        if (e.tag === 3) {
          Kr(
            e,
            t,
            l
          );
          break;
        } else if (e.tag === 1) {
          var n = e.stateNode;
          if (typeof e.type.getDerivedStateFromError == "function" || typeof n.componentDidCatch == "function" && (Pl === null || !Pl.has(n))) {
            t = We(l, t), l = Vo(2), n = kl(e, l, 2), n !== null && (ko(
              l,
              n,
              e,
              t
            ), Lt(n, 2), dl(n));
            break;
          }
        }
        e = e.return;
      }
  }
  function Tf(t, e, l) {
    var n = t.pingCache;
    if (n === null) {
      n = t.pingCache = new gm();
      var a = /* @__PURE__ */ new Set();
      n.set(e, a);
    } else
      a = n.get(e), a === void 0 && (a = /* @__PURE__ */ new Set(), n.set(e, a));
    a.has(l) || (hf = !0, a.add(l), t = vm.bind(null, t, e, l), e.then(t, t));
  }
  function vm(t, e, l) {
    var n = t.pingCache;
    n !== null && n.delete(e), t.pingedLanes |= t.suspendedLanes & l, t.warmLanes &= ~l, Gt === t && (yt & l) === l && (Wt === 4 || Wt === 3 && (yt & 62914560) === yt && 300 > It() - bi ? !(Ot & 2) && da(t, 0) : bf |= l, oa === yt && (oa = 0)), dl(t);
  }
  function Vr(t, e) {
    e === 0 && (e = P()), t = Sn(t, e), t !== null && (Lt(t, e), dl(t));
  }
  function Em(t) {
    var e = t.memoizedState, l = 0;
    e !== null && (l = e.retryLane), Vr(t, l);
  }
  function pm(t, e) {
    var l = 0;
    switch (t.tag) {
      case 31:
      case 13:
        var n = t.stateNode, a = t.memoizedState;
        a !== null && (l = a.retryLane);
        break;
      case 19:
        n = t.stateNode;
        break;
      case 22:
        n = t.stateNode._retryCache;
        break;
      default:
        throw Error(r(314));
    }
    n !== null && n.delete(e), Vr(t, l);
  }
  function Sm(t, e) {
    return Hn(t, e);
  }
  var Ti = null, ma = null, Af = !1, Ai = !1, Of = !1, ln = 0;
  function dl(t) {
    t !== ma && t.next === null && (ma === null ? Ti = ma = t : ma = ma.next = t), Ai = !0, Af || (Af = !0, Tm());
  }
  function fu(t, e) {
    if (!Of && Ai) {
      Of = !0;
      do
        for (var l = !1, n = Ti; n !== null; ) {
          if (t !== 0) {
            var a = n.pendingLanes;
            if (a === 0) var u = 0;
            else {
              var i = n.suspendedLanes, c = n.pingedLanes;
              u = (1 << 31 - Oe(42 | t) + 1) - 1, u &= a & ~(i & ~c), u = u & 201326741 ? u & 201326741 | 1 : u ? u | 2 : 0;
            }
            u !== 0 && (l = !0, Wr(n, u));
          } else
            u = yt, u = s(
              n,
              n === Gt ? u : 0,
              n.cancelPendingCommit !== null || n.timeoutHandle !== -1
            ), !(u & 3) || T(n, u) || (l = !0, Wr(n, u));
          n = n.next;
        }
      while (l);
      Of = !1;
    }
  }
  function _m() {
    kr();
  }
  function kr() {
    Ai = Af = !1;
    var t = 0;
    ln !== 0 && xm() && (t = ln);
    for (var e = It(), l = null, n = Ti; n !== null; ) {
      var a = n.next, u = Jr(n, e);
      u === 0 ? (n.next = null, l === null ? Ti = a : l.next = a, a === null && (ma = l)) : (l = n, (t !== 0 || u & 3) && (Ai = !0)), n = a;
    }
    re !== 0 && re !== 5 || fu(t), ln !== 0 && (ln = 0);
  }
  function Jr(t, e) {
    for (var l = t.suspendedLanes, n = t.pingedLanes, a = t.expirationTimes, u = t.pendingLanes & -62914561; 0 < u; ) {
      var i = 31 - Oe(u), c = 1 << i, f = a[i];
      f === -1 ? (!(c & l) || c & n) && (a[i] = B(c, e)) : f <= e && (t.expiredLanes |= c), u &= ~c;
    }
    if (e = Gt, l = yt, l = s(
      t,
      t === e ? l : 0,
      t.cancelPendingCommit !== null || t.timeoutHandle !== -1
    ), n = t.callbackNode, l === 0 || t === e && (Dt === 2 || Dt === 9) || t.cancelPendingCommit !== null)
      return n !== null && n !== null && Ta(n), t.callbackNode = null, t.callbackPriority = 0;
    if (!(l & 3) || T(t, l)) {
      if (e = l & -l, e === t.callbackPriority) return e;
      switch (n !== null && Ta(n), hl(l)) {
        case 2:
        case 8:
          l = on;
          break;
        case 32:
          l = rn;
          break;
        case 268435456:
          l = Au;
          break;
        default:
          l = rn;
      }
      return n = $r.bind(null, t), l = Hn(l, n), t.callbackPriority = e, t.callbackNode = l, e;
    }
    return n !== null && n !== null && Ta(n), t.callbackPriority = 2, t.callbackNode = null, 2;
  }
  function $r(t, e) {
    if (re !== 0 && re !== 5)
      return t.callbackNode = null, t.callbackPriority = 0, null;
    var l = t.callbackNode;
    if (_i() && t.callbackNode !== l)
      return null;
    var n = yt;
    return n = s(
      t,
      t === Gt ? n : 0,
      t.cancelPendingCommit !== null || t.timeoutHandle !== -1
    ), n === 0 ? null : (Dr(t, n, e), Jr(t, It()), t.callbackNode != null && t.callbackNode === l ? $r.bind(null, t) : null);
  }
  function Wr(t, e) {
    if (_i()) return null;
    Dr(t, e, !0);
  }
  function Tm() {
    Hm(function() {
      Ot & 6 ? Hn(
        ml,
        _m
      ) : kr();
    });
  }
  function Nf() {
    if (ln === 0) {
      var t = Pn;
      t === 0 && (t = gn, gn <<= 1, !(gn & 261888) && (gn = 256)), ln = t;
    }
    return ln;
  }
  function Ir(t) {
    return t == null || typeof t == "symbol" || typeof t == "boolean" ? null : typeof t == "function" ? t : Yl("" + t);
  }
  function Fr(t, e) {
    var l = e.ownerDocument.createElement("input");
    return l.name = e.name, l.value = e.value, t.id && l.setAttribute("form", t.id), e.parentNode.insertBefore(l, e), t = new FormData(t), l.parentNode.removeChild(l), t;
  }
  function Am(t, e, l, n, a) {
    if (e === "submit" && l && l.stateNode === a) {
      var u = Ir(
        (a[_e] || null).action
      ), i = n.submitter;
      i && (e = (e = i[_e] || null) ? Ir(e.formAction) : i.getAttribute("formAction"), e !== null && (u = e, i = null));
      var c = new Lu(
        "action",
        "action",
        null,
        n,
        a
      );
      t.push({
        event: c,
        listeners: [
          {
            instance: null,
            listener: function() {
              if (n.defaultPrevented) {
                if (ln !== 0) {
                  var f = i ? Fr(a, i) : new FormData(a);
                  Kc(
                    l,
                    {
                      pending: !0,
                      data: f,
                      method: a.method,
                      action: u
                    },
                    null,
                    f
                  );
                }
              } else
                typeof u == "function" && (c.preventDefault(), f = i ? Fr(a, i) : new FormData(a), Kc(
                  l,
                  {
                    pending: !0,
                    data: f,
                    method: a.method,
                    action: u
                  },
                  u,
                  f
                ));
            },
            currentTarget: a
          }
        ]
      });
    }
  }
  for (var Mf = 0; Mf < fc.length; Mf++) {
    var Rf = fc[Mf], Om = Rf.toLowerCase(), Nm = Rf[0].toUpperCase() + Rf.slice(1);
    nl(
      Om,
      "on" + Nm
    );
  }
  nl(Rs, "onAnimationEnd"), nl(zs, "onAnimationIteration"), nl(Ds, "onAnimationStart"), nl("dblclick", "onDoubleClick"), nl("focusin", "onFocus"), nl("focusout", "onBlur"), nl(Zg, "onTransitionRun"), nl(jg, "onTransitionStart"), nl(Qg, "onTransitionCancel"), nl(Cs, "onTransitionEnd"), M("onMouseEnter", ["mouseout", "mouseover"]), M("onMouseLeave", ["mouseout", "mouseover"]), M("onPointerEnter", ["pointerout", "pointerover"]), M("onPointerLeave", ["pointerout", "pointerover"]), yl(
    "onChange",
    "change click focusin focusout input keydown keyup selectionchange".split(" ")
  ), yl(
    "onSelect",
    "focusout contextmenu dragend focusin keydown keyup mousedown mouseup selectionchange".split(
      " "
    )
  ), yl("onBeforeInput", [
    "compositionend",
    "keypress",
    "textInput",
    "paste"
  ]), yl(
    "onCompositionEnd",
    "compositionend focusout keydown keypress keyup mousedown".split(" ")
  ), yl(
    "onCompositionStart",
    "compositionstart focusout keydown keypress keyup mousedown".split(" ")
  ), yl(
    "onCompositionUpdate",
    "compositionupdate focusout keydown keypress keyup mousedown".split(" ")
  );
  var su = "abort canplay canplaythrough durationchange emptied encrypted ended error loadeddata loadedmetadata loadstart pause play playing progress ratechange resize seeked seeking stalled suspend timeupdate volumechange waiting".split(
    " "
  ), Mm = new Set(
    "beforetoggle cancel close invalid load scroll scrollend toggle".split(" ").concat(su)
  );
  function Pr(t, e) {
    e = (e & 4) !== 0;
    for (var l = 0; l < t.length; l++) {
      var n = t[l], a = n.event;
      n = n.listeners;
      t: {
        var u = void 0;
        if (e)
          for (var i = n.length - 1; 0 <= i; i--) {
            var c = n[i], f = c.instance, b = c.currentTarget;
            if (c = c.listener, f !== u && a.isPropagationStopped())
              break t;
            u = c, a.currentTarget = b;
            try {
              u(a);
            } catch (S) {
              Yu(S);
            }
            a.currentTarget = null, u = f;
          }
        else
          for (i = 0; i < n.length; i++) {
            if (c = n[i], f = c.instance, b = c.currentTarget, c = c.listener, f !== u && a.isPropagationStopped())
              break t;
            u = c, a.currentTarget = b;
            try {
              u(a);
            } catch (S) {
              Yu(S);
            }
            a.currentTarget = null, u = f;
          }
      }
    }
  }
  function mt(t, e) {
    var l = e[Oa];
    l === void 0 && (l = e[Oa] = /* @__PURE__ */ new Set());
    var n = t + "__bubble";
    l.has(n) || (td(e, t, 2, !1), l.add(n));
  }
  function zf(t, e, l) {
    var n = 0;
    e && (n |= 4), td(
      l,
      t,
      n,
      e
    );
  }
  var Oi = "_reactListening" + Math.random().toString(36).slice(2);
  function Df(t) {
    if (!t[Oi]) {
      t[Oi] = !0, Ru.forEach(function(l) {
        l !== "selectionchange" && (Mm.has(l) || zf(l, !1, t), zf(l, !0, t));
      });
      var e = t.nodeType === 9 ? t : t.ownerDocument;
      e === null || e[Oi] || (e[Oi] = !0, zf("selectionchange", !1, e));
    }
  }
  function td(t, e, l, n) {
    switch (zd(e)) {
      case 2:
        var a = eh;
        break;
      case 8:
        a = lh;
        break;
      default:
        a = Kf;
    }
    l = a.bind(
      null,
      e,
      l,
      t
    ), a = void 0, !$i || e !== "touchstart" && e !== "touchmove" && e !== "wheel" || (a = !0), n ? a !== void 0 ? t.addEventListener(e, l, {
      capture: !0,
      passive: a
    }) : t.addEventListener(e, l, !0) : a !== void 0 ? t.addEventListener(e, l, {
      passive: a
    }) : t.addEventListener(e, l, !1);
  }
  function Cf(t, e, l, n, a) {
    var u = n;
    if (!(e & 1) && !(e & 2) && n !== null)
      t: for (; ; ) {
        if (n === null) return;
        var i = n.tag;
        if (i === 3 || i === 4) {
          var c = n.stateNode.containerInfo;
          if (c === a) break;
          if (i === 4)
            for (i = n.return; i !== null; ) {
              var f = i.tag;
              if ((f === 3 || f === 4) && i.stateNode.containerInfo === a)
                return;
              i = i.return;
            }
          for (; c !== null; ) {
            if (i = Ne(c), i === null) return;
            if (f = i.tag, f === 5 || f === 6 || f === 26 || f === 27) {
              n = u = i;
              continue t;
            }
            c = c.parentNode;
          }
        }
        n = n.return;
      }
    Uu(function() {
      var b = u, S = it(l), O = [];
      t: {
        var y = Us.get(t);
        if (y !== void 0) {
          var v = Lu, G = t;
          switch (t) {
            case "keypress":
              if (Bu(l) === 0) break t;
            case "keydown":
            case "keyup":
              v = pg;
              break;
            case "focusin":
              G = "focus", v = Pi;
              break;
            case "focusout":
              G = "blur", v = Pi;
              break;
            case "beforeblur":
            case "afterblur":
              v = Pi;
              break;
            case "click":
              if (l.button === 2) break t;
            case "auxclick":
            case "dblclick":
            case "mousedown":
            case "mousemove":
            case "mouseup":
            case "mouseout":
            case "mouseover":
            case "contextmenu":
              v = cs;
              break;
            case "drag":
            case "dragend":
            case "dragenter":
            case "dragexit":
            case "dragleave":
            case "dragover":
            case "dragstart":
            case "drop":
              v = fg;
              break;
            case "touchcancel":
            case "touchend":
            case "touchmove":
            case "touchstart":
              v = Tg;
              break;
            case Rs:
            case zs:
            case Ds:
              v = rg;
              break;
            case Cs:
              v = Og;
              break;
            case "scroll":
            case "scrollend":
              v = ig;
              break;
            case "wheel":
              v = Mg;
              break;
            case "copy":
            case "cut":
            case "paste":
              v = gg;
              break;
            case "gotpointercapture":
            case "lostpointercapture":
            case "pointercancel":
            case "pointerdown":
            case "pointermove":
            case "pointerout":
            case "pointerover":
            case "pointerup":
              v = ss;
              break;
            case "toggle":
            case "beforetoggle":
              v = zg;
          }
          var k = (e & 4) !== 0, Bt = !k && (t === "scroll" || t === "scrollend"), m = k ? y !== null ? y + "Capture" : null : y;
          k = [];
          for (var d = b, h; d !== null; ) {
            var A = d;
            if (h = A.stateNode, A = A.tag, A !== 5 && A !== 26 && A !== 27 || h === null || m === null || (A = Ca(d, m), A != null && k.push(
              ou(d, A, h)
            )), Bt) break;
            d = d.return;
          }
          0 < k.length && (y = new v(
            y,
            G,
            null,
            l,
            S
          ), O.push({ event: y, listeners: k }));
        }
      }
      if (!(e & 7)) {
        t: {
          if (y = t === "mouseover" || t === "pointerover", v = t === "mouseout" || t === "pointerout", y && l !== w && (G = l.relatedTarget || l.fromElement) && (Ne(G) || G[Hl]))
            break t;
          if ((v || y) && (y = S.window === S ? S : (y = S.ownerDocument) ? y.defaultView || y.parentWindow : window, v ? (G = l.relatedTarget || l.toElement, v = b, G = G ? Ne(G) : null, G !== null && (Bt = at(G), k = G.tag, G !== Bt || k !== 5 && k !== 27 && k !== 6) && (G = null)) : (v = null, G = b), v !== G)) {
            if (k = cs, A = "onMouseLeave", m = "onMouseEnter", d = "mouse", (t === "pointerout" || t === "pointerover") && (k = ss, A = "onPointerLeave", m = "onPointerEnter", d = "pointer"), Bt = v == null ? y : Ll(v), h = G == null ? y : Ll(G), y = new k(
              A,
              d + "leave",
              v,
              l,
              S
            ), y.target = Bt, y.relatedTarget = h, A = null, Ne(S) === b && (k = new k(
              m,
              d + "enter",
              G,
              l,
              S
            ), k.target = h, k.relatedTarget = Bt, A = k), Bt = A, v && G)
              e: {
                for (k = Rm, m = v, d = G, h = 0, A = m; A; A = k(A))
                  h++;
                A = 0;
                for (var K = d; K; K = k(K))
                  A++;
                for (; 0 < h - A; )
                  m = k(m), h--;
                for (; 0 < A - h; )
                  d = k(d), A--;
                for (; h--; ) {
                  if (m === d || d !== null && m === d.alternate) {
                    k = m;
                    break e;
                  }
                  m = k(m), d = k(d);
                }
                k = null;
              }
            else k = null;
            v !== null && ed(
              O,
              y,
              v,
              k,
              !1
            ), G !== null && Bt !== null && ed(
              O,
              Bt,
              G,
              k,
              !0
            );
          }
        }
        t: {
          if (y = b ? Ll(b) : window, v = y.nodeName && y.nodeName.toLowerCase(), v === "select" || v === "input" && y.type === "file")
            var Tt = ys;
          else if (hs(y))
            if (vs)
              Tt = Yg;
            else {
              Tt = Gg;
              var X = Lg;
            }
          else
            v = y.nodeName, !v || v.toLowerCase() !== "input" || y.type !== "checkbox" && y.type !== "radio" ? b && ql(b.elementType) && (Tt = ys) : Tt = qg;
          if (Tt && (Tt = Tt(t, b))) {
            bs(
              O,
              Tt,
              l,
              S
            );
            break t;
          }
          X && X(t, y, b), t === "focusout" && b && y.type === "number" && b.memoizedProps.value != null && Zn(y, "number", y.value);
        }
        switch (X = b ? Ll(b) : window, t) {
          case "focusin":
            (hs(X) || X.contentEditable === "true") && (Kn = X, uc = b, Ya = null);
            break;
          case "focusout":
            Ya = uc = Kn = null;
            break;
          case "mousedown":
            ic = !0;
            break;
          case "contextmenu":
          case "mouseup":
          case "dragend":
            ic = !1, Ns(O, l, S);
            break;
          case "selectionchange":
            if (Xg) break;
          case "keydown":
          case "keyup":
            Ns(O, l, S);
        }
        var st;
        if (ec)
          t: {
            switch (t) {
              case "compositionstart":
                var vt = "onCompositionStart";
                break t;
              case "compositionend":
                vt = "onCompositionEnd";
                break t;
              case "compositionupdate":
                vt = "onCompositionUpdate";
                break t;
            }
            vt = void 0;
          }
        else
          Qn ? gs(t, l) && (vt = "onCompositionEnd") : t === "keydown" && l.keyCode === 229 && (vt = "onCompositionStart");
        vt && (os && l.locale !== "ko" && (Qn || vt !== "onCompositionStart" ? vt === "onCompositionEnd" && Qn && (st = us()) : (wl = S, Wi = "value" in wl ? wl.value : wl.textContent, Qn = !0)), X = Ni(b, vt), 0 < X.length && (vt = new fs(
          vt,
          t,
          null,
          l,
          S
        ), O.push({ event: vt, listeners: X }), st ? vt.data = st : (st = ms(l), st !== null && (vt.data = st)))), (st = Cg ? Ug(t, l) : xg(t, l)) && (vt = Ni(b, "onBeforeInput"), 0 < vt.length && (X = new fs(
          "onBeforeInput",
          "beforeinput",
          null,
          l,
          S
        ), O.push({
          event: X,
          listeners: vt
        }), X.data = st)), Am(
          O,
          t,
          b,
          l,
          S
        );
      }
      Pr(O, e);
    });
  }
  function ou(t, e, l) {
    return {
      instance: t,
      listener: e,
      currentTarget: l
    };
  }
  function Ni(t, e) {
    for (var l = e + "Capture", n = []; t !== null; ) {
      var a = t, u = a.stateNode;
      if (a = a.tag, a !== 5 && a !== 26 && a !== 27 || u === null || (a = Ca(t, l), a != null && n.unshift(
        ou(t, a, u)
      ), a = Ca(t, e), a != null && n.push(
        ou(t, a, u)
      )), t.tag === 3) return n;
      t = t.return;
    }
    return [];
  }
  function Rm(t) {
    if (t === null) return null;
    do
      t = t.return;
    while (t && t.tag !== 5 && t.tag !== 27);
    return t || null;
  }
  function ed(t, e, l, n, a) {
    for (var u = e._reactName, i = []; l !== null && l !== n; ) {
      var c = l, f = c.alternate, b = c.stateNode;
      if (c = c.tag, f !== null && f === n) break;
      c !== 5 && c !== 26 && c !== 27 || b === null || (f = b, a ? (b = Ca(l, u), b != null && i.unshift(
        ou(l, b, f)
      )) : a || (b = Ca(l, u), b != null && i.push(
        ou(l, b, f)
      ))), l = l.return;
    }
    i.length !== 0 && t.push({ event: e, listeners: i });
  }
  var zm = /\r\n?/g, Dm = /\u0000|\uFFFD/g;
  function ld(t) {
    return (typeof t == "string" ? t : "" + t).replace(zm, `
`).replace(Dm, "");
  }
  function nd(t, e) {
    return e = ld(e), ld(t) === e;
  }
  function xt(t, e, l, n, a, u) {
    switch (l) {
      case "children":
        typeof n == "string" ? e === "body" || e === "textarea" && n === "" || $(t, n) : (typeof n == "number" || typeof n == "bigint") && e !== "body" && $(t, "" + n);
        break;
      case "className":
        Ye(t, "class", n);
        break;
      case "tabIndex":
        Ye(t, "tabindex", n);
        break;
      case "dir":
      case "role":
      case "viewBox":
      case "width":
      case "height":
        Ye(t, l, n);
        break;
      case "style":
        zt(t, n, u);
        break;
      case "data":
        if (e !== "object") {
          Ye(t, "data", n);
          break;
        }
      case "src":
      case "href":
        if (n === "" && (e !== "a" || l !== "href")) {
          t.removeAttribute(l);
          break;
        }
        if (n == null || typeof n == "function" || typeof n == "symbol" || typeof n == "boolean") {
          t.removeAttribute(l);
          break;
        }
        n = Yl("" + n), t.setAttribute(l, n);
        break;
      case "action":
      case "formAction":
        if (typeof n == "function") {
          t.setAttribute(
            l,
            "javascript:throw new Error('A React form was unexpectedly submitted. If you called form.submit() manually, consider using form.requestSubmit() instead. If you\\'re trying to use event.stopPropagation() in a submit event handler, consider also calling event.preventDefault().')"
          );
          break;
        } else
          typeof u == "function" && (l === "formAction" ? (e !== "input" && xt(t, e, "name", a.name, a, null), xt(
            t,
            e,
            "formEncType",
            a.formEncType,
            a,
            null
          ), xt(
            t,
            e,
            "formMethod",
            a.formMethod,
            a,
            null
          ), xt(
            t,
            e,
            "formTarget",
            a.formTarget,
            a,
            null
          )) : (xt(t, e, "encType", a.encType, a, null), xt(t, e, "method", a.method, a, null), xt(t, e, "target", a.target, a, null)));
        if (n == null || typeof n == "symbol" || typeof n == "boolean") {
          t.removeAttribute(l);
          break;
        }
        n = Yl("" + n), t.setAttribute(l, n);
        break;
      case "onClick":
        n != null && (t.onclick = D);
        break;
      case "onScroll":
        n != null && mt("scroll", t);
        break;
      case "onScrollEnd":
        n != null && mt("scrollend", t);
        break;
      case "dangerouslySetInnerHTML":
        if (n != null) {
          if (typeof n != "object" || !("__html" in n))
            throw Error(r(61));
          if (l = n.__html, l != null) {
            if (a.children != null) throw Error(r(60));
            t.innerHTML = l;
          }
        }
        break;
      case "multiple":
        t.multiple = n && typeof n != "function" && typeof n != "symbol";
        break;
      case "muted":
        t.muted = n && typeof n != "function" && typeof n != "symbol";
        break;
      case "suppressContentEditableWarning":
      case "suppressHydrationWarning":
      case "defaultValue":
      case "defaultChecked":
      case "innerHTML":
      case "ref":
        break;
      case "autoFocus":
        break;
      case "xlinkHref":
        if (n == null || typeof n == "function" || typeof n == "boolean" || typeof n == "symbol") {
          t.removeAttribute("xlink:href");
          break;
        }
        l = Yl("" + n), t.setAttributeNS(
          "http://www.w3.org/1999/xlink",
          "xlink:href",
          l
        );
        break;
      case "contentEditable":
      case "spellCheck":
      case "draggable":
      case "value":
      case "autoReverse":
      case "externalResourcesRequired":
      case "focusable":
      case "preserveAlpha":
        n != null && typeof n != "function" && typeof n != "symbol" ? t.setAttribute(l, "" + n) : t.removeAttribute(l);
        break;
      case "inert":
      case "allowFullScreen":
      case "async":
      case "autoPlay":
      case "controls":
      case "default":
      case "defer":
      case "disabled":
      case "disablePictureInPicture":
      case "disableRemotePlayback":
      case "formNoValidate":
      case "hidden":
      case "loop":
      case "noModule":
      case "noValidate":
      case "open":
      case "playsInline":
      case "readOnly":
      case "required":
      case "reversed":
      case "scoped":
      case "seamless":
      case "itemScope":
        n && typeof n != "function" && typeof n != "symbol" ? t.setAttribute(l, "") : t.removeAttribute(l);
        break;
      case "capture":
      case "download":
        n === !0 ? t.setAttribute(l, "") : n !== !1 && n != null && typeof n != "function" && typeof n != "symbol" ? t.setAttribute(l, n) : t.removeAttribute(l);
        break;
      case "cols":
      case "rows":
      case "size":
      case "span":
        n != null && typeof n != "function" && typeof n != "symbol" && !isNaN(n) && 1 <= n ? t.setAttribute(l, n) : t.removeAttribute(l);
        break;
      case "rowSpan":
      case "start":
        n == null || typeof n == "function" || typeof n == "symbol" || isNaN(n) ? t.removeAttribute(l) : t.setAttribute(l, n);
        break;
      case "popover":
        mt("beforetoggle", t), mt("toggle", t), Te(t, "popover", n);
        break;
      case "xlinkActuate":
        ze(
          t,
          "http://www.w3.org/1999/xlink",
          "xlink:actuate",
          n
        );
        break;
      case "xlinkArcrole":
        ze(
          t,
          "http://www.w3.org/1999/xlink",
          "xlink:arcrole",
          n
        );
        break;
      case "xlinkRole":
        ze(
          t,
          "http://www.w3.org/1999/xlink",
          "xlink:role",
          n
        );
        break;
      case "xlinkShow":
        ze(
          t,
          "http://www.w3.org/1999/xlink",
          "xlink:show",
          n
        );
        break;
      case "xlinkTitle":
        ze(
          t,
          "http://www.w3.org/1999/xlink",
          "xlink:title",
          n
        );
        break;
      case "xlinkType":
        ze(
          t,
          "http://www.w3.org/1999/xlink",
          "xlink:type",
          n
        );
        break;
      case "xmlBase":
        ze(
          t,
          "http://www.w3.org/XML/1998/namespace",
          "xml:base",
          n
        );
        break;
      case "xmlLang":
        ze(
          t,
          "http://www.w3.org/XML/1998/namespace",
          "xml:lang",
          n
        );
        break;
      case "xmlSpace":
        ze(
          t,
          "http://www.w3.org/XML/1998/namespace",
          "xml:space",
          n
        );
        break;
      case "is":
        Te(t, "is", n);
        break;
      case "innerText":
      case "textContent":
        break;
      default:
        (!(2 < l.length) || l[0] !== "o" && l[0] !== "O" || l[1] !== "n" && l[1] !== "N") && (l = vl.get(l) || l, Te(t, l, n));
    }
  }
  function Uf(t, e, l, n, a, u) {
    switch (l) {
      case "style":
        zt(t, n, u);
        break;
      case "dangerouslySetInnerHTML":
        if (n != null) {
          if (typeof n != "object" || !("__html" in n))
            throw Error(r(61));
          if (l = n.__html, l != null) {
            if (a.children != null) throw Error(r(60));
            t.innerHTML = l;
          }
        }
        break;
      case "children":
        typeof n == "string" ? $(t, n) : (typeof n == "number" || typeof n == "bigint") && $(t, "" + n);
        break;
      case "onScroll":
        n != null && mt("scroll", t);
        break;
      case "onScrollEnd":
        n != null && mt("scrollend", t);
        break;
      case "onClick":
        n != null && (t.onclick = D);
        break;
      case "suppressContentEditableWarning":
      case "suppressHydrationWarning":
      case "innerHTML":
      case "ref":
        break;
      case "innerText":
      case "textContent":
        break;
      default:
        if (!bn.hasOwnProperty(l))
          t: {
            if (l[0] === "o" && l[1] === "n" && (a = l.endsWith("Capture"), e = l.slice(2, a ? l.length - 7 : void 0), u = t[_e] || null, u = u != null ? u[l] : null, typeof u == "function" && t.removeEventListener(e, u, a), typeof n == "function")) {
              typeof u != "function" && u !== null && (l in t ? t[l] = null : t.hasAttribute(l) && t.removeAttribute(l)), t.addEventListener(e, n, a);
              break t;
            }
            l in t ? t[l] = n : n === !0 ? t.setAttribute(l, "") : Te(t, l, n);
          }
    }
  }
  function pe(t, e, l) {
    switch (e) {
      case "div":
      case "span":
      case "svg":
      case "path":
      case "a":
      case "g":
      case "p":
      case "li":
        break;
      case "img":
        mt("error", t), mt("load", t);
        var n = !1, a = !1, u;
        for (u in l)
          if (l.hasOwnProperty(u)) {
            var i = l[u];
            if (i != null)
              switch (u) {
                case "src":
                  n = !0;
                  break;
                case "srcSet":
                  a = !0;
                  break;
                case "children":
                case "dangerouslySetInnerHTML":
                  throw Error(r(137, e));
                default:
                  xt(t, e, u, i, l, null);
              }
          }
        a && xt(t, e, "srcSet", l.srcSet, l, null), n && xt(t, e, "src", l.src, l, null);
        return;
      case "input":
        mt("invalid", t);
        var c = u = i = a = null, f = null, b = null;
        for (n in l)
          if (l.hasOwnProperty(n)) {
            var S = l[n];
            if (S != null)
              switch (n) {
                case "name":
                  a = S;
                  break;
                case "type":
                  i = S;
                  break;
                case "checked":
                  f = S;
                  break;
                case "defaultChecked":
                  b = S;
                  break;
                case "value":
                  u = S;
                  break;
                case "defaultValue":
                  c = S;
                  break;
                case "children":
                case "dangerouslySetInnerHTML":
                  if (S != null)
                    throw Error(r(137, e));
                  break;
                default:
                  xt(t, e, n, S, l, null);
              }
          }
        yn(
          t,
          u,
          c,
          f,
          b,
          i,
          a,
          !1
        );
        return;
      case "select":
        mt("invalid", t), n = i = u = null;
        for (a in l)
          if (l.hasOwnProperty(a) && (c = l[a], c != null))
            switch (a) {
              case "value":
                u = c;
                break;
              case "defaultValue":
                i = c;
                break;
              case "multiple":
                n = c;
              default:
                xt(t, e, a, c, l, null);
            }
        e = u, l = i, t.multiple = !!n, e != null ? be(t, !!n, e, !1) : l != null && be(t, !!n, l, !0);
        return;
      case "textarea":
        mt("invalid", t), u = a = n = null;
        for (i in l)
          if (l.hasOwnProperty(i) && (c = l[i], c != null))
            switch (i) {
              case "value":
                n = c;
                break;
              case "defaultValue":
                a = c;
                break;
              case "children":
                u = c;
                break;
              case "dangerouslySetInnerHTML":
                if (c != null) throw Error(r(91));
                break;
              default:
                xt(t, e, i, c, l, null);
            }
        jn(t, n, a, u);
        return;
      case "option":
        for (f in l)
          if (l.hasOwnProperty(f) && (n = l[f], n != null))
            switch (f) {
              case "selected":
                t.selected = n && typeof n != "function" && typeof n != "symbol";
                break;
              default:
                xt(t, e, f, n, l, null);
            }
        return;
      case "dialog":
        mt("beforetoggle", t), mt("toggle", t), mt("cancel", t), mt("close", t);
        break;
      case "iframe":
      case "object":
        mt("load", t);
        break;
      case "video":
      case "audio":
        for (n = 0; n < su.length; n++)
          mt(su[n], t);
        break;
      case "image":
        mt("error", t), mt("load", t);
        break;
      case "details":
        mt("toggle", t);
        break;
      case "embed":
      case "source":
      case "link":
        mt("error", t), mt("load", t);
      case "area":
      case "base":
      case "br":
      case "col":
      case "hr":
      case "keygen":
      case "meta":
      case "param":
      case "track":
      case "wbr":
      case "menuitem":
        for (b in l)
          if (l.hasOwnProperty(b) && (n = l[b], n != null))
            switch (b) {
              case "children":
              case "dangerouslySetInnerHTML":
                throw Error(r(137, e));
              default:
                xt(t, e, b, n, l, null);
            }
        return;
      default:
        if (ql(e)) {
          for (S in l)
            l.hasOwnProperty(S) && (n = l[S], n !== void 0 && Uf(
              t,
              e,
              S,
              n,
              l,
              void 0
            ));
          return;
        }
    }
    for (c in l)
      l.hasOwnProperty(c) && (n = l[c], n != null && xt(t, e, c, n, l, null));
  }
  function Cm(t, e, l, n) {
    switch (e) {
      case "div":
      case "span":
      case "svg":
      case "path":
      case "a":
      case "g":
      case "p":
      case "li":
        break;
      case "input":
        var a = null, u = null, i = null, c = null, f = null, b = null, S = null;
        for (v in l) {
          var O = l[v];
          if (l.hasOwnProperty(v) && O != null)
            switch (v) {
              case "checked":
                break;
              case "value":
                break;
              case "defaultValue":
                f = O;
              default:
                n.hasOwnProperty(v) || xt(t, e, v, null, n, O);
            }
        }
        for (var y in n) {
          var v = n[y];
          if (O = l[y], n.hasOwnProperty(y) && (v != null || O != null))
            switch (y) {
              case "type":
                u = v;
                break;
              case "name":
                a = v;
                break;
              case "checked":
                b = v;
                break;
              case "defaultChecked":
                S = v;
                break;
              case "value":
                i = v;
                break;
              case "defaultValue":
                c = v;
                break;
              case "children":
              case "dangerouslySetInnerHTML":
                if (v != null)
                  throw Error(r(137, e));
                break;
              default:
                v !== O && xt(
                  t,
                  e,
                  y,
                  v,
                  n,
                  O
                );
            }
        }
        Ra(
          t,
          i,
          c,
          f,
          b,
          S,
          u,
          a
        );
        return;
      case "select":
        v = i = c = y = null;
        for (u in l)
          if (f = l[u], l.hasOwnProperty(u) && f != null)
            switch (u) {
              case "value":
                break;
              case "multiple":
                v = f;
              default:
                n.hasOwnProperty(u) || xt(
                  t,
                  e,
                  u,
                  null,
                  n,
                  f
                );
            }
        for (a in n)
          if (u = n[a], f = l[a], n.hasOwnProperty(a) && (u != null || f != null))
            switch (a) {
              case "value":
                y = u;
                break;
              case "defaultValue":
                c = u;
                break;
              case "multiple":
                i = u;
              default:
                u !== f && xt(
                  t,
                  e,
                  a,
                  u,
                  n,
                  f
                );
            }
        e = c, l = i, n = v, y != null ? be(t, !!l, y, !1) : !!n != !!l && (e != null ? be(t, !!l, e, !0) : be(t, !!l, l ? [] : "", !1));
        return;
      case "textarea":
        v = y = null;
        for (c in l)
          if (a = l[c], l.hasOwnProperty(c) && a != null && !n.hasOwnProperty(c))
            switch (c) {
              case "value":
                break;
              case "children":
                break;
              default:
                xt(t, e, c, null, n, a);
            }
        for (i in n)
          if (a = n[i], u = l[i], n.hasOwnProperty(i) && (a != null || u != null))
            switch (i) {
              case "value":
                y = a;
                break;
              case "defaultValue":
                v = a;
                break;
              case "children":
                break;
              case "dangerouslySetInnerHTML":
                if (a != null) throw Error(r(91));
                break;
              default:
                a !== u && xt(t, e, i, a, n, u);
            }
        Du(t, y, v);
        return;
      case "option":
        for (var G in l)
          if (y = l[G], l.hasOwnProperty(G) && y != null && !n.hasOwnProperty(G))
            switch (G) {
              case "selected":
                t.selected = !1;
                break;
              default:
                xt(
                  t,
                  e,
                  G,
                  null,
                  n,
                  y
                );
            }
        for (f in n)
          if (y = n[f], v = l[f], n.hasOwnProperty(f) && y !== v && (y != null || v != null))
            switch (f) {
              case "selected":
                t.selected = y && typeof y != "function" && typeof y != "symbol";
                break;
              default:
                xt(
                  t,
                  e,
                  f,
                  y,
                  n,
                  v
                );
            }
        return;
      case "img":
      case "link":
      case "area":
      case "base":
      case "br":
      case "col":
      case "embed":
      case "hr":
      case "keygen":
      case "meta":
      case "param":
      case "source":
      case "track":
      case "wbr":
      case "menuitem":
        for (var k in l)
          y = l[k], l.hasOwnProperty(k) && y != null && !n.hasOwnProperty(k) && xt(t, e, k, null, n, y);
        for (b in n)
          if (y = n[b], v = l[b], n.hasOwnProperty(b) && y !== v && (y != null || v != null))
            switch (b) {
              case "children":
              case "dangerouslySetInnerHTML":
                if (y != null)
                  throw Error(r(137, e));
                break;
              default:
                xt(
                  t,
                  e,
                  b,
                  y,
                  n,
                  v
                );
            }
        return;
      default:
        if (ql(e)) {
          for (var Bt in l)
            y = l[Bt], l.hasOwnProperty(Bt) && y !== void 0 && !n.hasOwnProperty(Bt) && Uf(
              t,
              e,
              Bt,
              void 0,
              n,
              y
            );
          for (S in n)
            y = n[S], v = l[S], !n.hasOwnProperty(S) || y === v || y === void 0 && v === void 0 || Uf(
              t,
              e,
              S,
              y,
              n,
              v
            );
          return;
        }
    }
    for (var m in l)
      y = l[m], l.hasOwnProperty(m) && y != null && !n.hasOwnProperty(m) && xt(t, e, m, null, n, y);
    for (O in n)
      y = n[O], v = l[O], !n.hasOwnProperty(O) || y === v || y == null && v == null || xt(t, e, O, y, n, v);
  }
  function ad(t) {
    switch (t) {
      case "css":
      case "script":
      case "font":
      case "img":
      case "image":
      case "input":
      case "link":
        return !0;
      default:
        return !1;
    }
  }
  function Um() {
    if (typeof performance.getEntriesByType == "function") {
      for (var t = 0, e = 0, l = performance.getEntriesByType("resource"), n = 0; n < l.length; n++) {
        var a = l[n], u = a.transferSize, i = a.initiatorType, c = a.duration;
        if (u && c && ad(i)) {
          for (i = 0, c = a.responseEnd, n += 1; n < l.length; n++) {
            var f = l[n], b = f.startTime;
            if (b > c) break;
            var S = f.transferSize, O = f.initiatorType;
            S && ad(O) && (f = f.responseEnd, i += S * (f < c ? 1 : (c - b) / (f - b)));
          }
          if (--n, e += 8 * (u + i) / (a.duration / 1e3), t++, 10 < t) break;
        }
      }
      if (0 < t) return e / t / 1e6;
    }
    return navigator.connection && (t = navigator.connection.downlink, typeof t == "number") ? t : 5;
  }
  var xf = null, Bf = null;
  function Mi(t) {
    return t.nodeType === 9 ? t : t.ownerDocument;
  }
  function ud(t) {
    switch (t) {
      case "http://www.w3.org/2000/svg":
        return 1;
      case "http://www.w3.org/1998/Math/MathML":
        return 2;
      default:
        return 0;
    }
  }
  function id(t, e) {
    if (t === 0)
      switch (e) {
        case "svg":
          return 1;
        case "math":
          return 2;
        default:
          return 0;
      }
    return t === 1 && e === "foreignObject" ? 0 : t;
  }
  function Hf(t, e) {
    return t === "textarea" || t === "noscript" || typeof e.children == "string" || typeof e.children == "number" || typeof e.children == "bigint" || typeof e.dangerouslySetInnerHTML == "object" && e.dangerouslySetInnerHTML !== null && e.dangerouslySetInnerHTML.__html != null;
  }
  var Lf = null;
  function xm() {
    var t = window.event;
    return t && t.type === "popstate" ? t === Lf ? !1 : (Lf = t, !0) : (Lf = null, !1);
  }
  var cd = typeof setTimeout == "function" ? setTimeout : void 0, Bm = typeof clearTimeout == "function" ? clearTimeout : void 0, fd = typeof Promise == "function" ? Promise : void 0, Hm = typeof queueMicrotask == "function" ? queueMicrotask : typeof fd < "u" ? function(t) {
    return fd.resolve(null).then(t).catch(Lm);
  } : cd;
  function Lm(t) {
    setTimeout(function() {
      throw t;
    });
  }
  function nn(t) {
    return t === "head";
  }
  function sd(t, e) {
    var l = e, n = 0;
    do {
      var a = l.nextSibling;
      if (t.removeChild(l), a && a.nodeType === 8)
        if (l = a.data, l === "/$" || l === "/&") {
          if (n === 0) {
            t.removeChild(a), va(e);
            return;
          }
          n--;
        } else if (l === "$" || l === "$?" || l === "$~" || l === "$!" || l === "&")
          n++;
        else if (l === "html")
          ru(t.ownerDocument.documentElement);
        else if (l === "head") {
          l = t.ownerDocument.head, ru(l);
          for (var u = l.firstChild; u; ) {
            var i = u.nextSibling, c = u.nodeName;
            u[hn] || c === "SCRIPT" || c === "STYLE" || c === "LINK" && u.rel.toLowerCase() === "stylesheet" || l.removeChild(u), u = i;
          }
        } else
          l === "body" && ru(t.ownerDocument.body);
      l = a;
    } while (l);
    va(e);
  }
  function od(t, e) {
    var l = t;
    t = 0;
    do {
      var n = l.nextSibling;
      if (l.nodeType === 1 ? e ? (l._stashedDisplay = l.style.display, l.style.display = "none") : (l.style.display = l._stashedDisplay || "", l.getAttribute("style") === "" && l.removeAttribute("style")) : l.nodeType === 3 && (e ? (l._stashedText = l.nodeValue, l.nodeValue = "") : l.nodeValue = l._stashedText || ""), n && n.nodeType === 8)
        if (l = n.data, l === "/$") {
          if (t === 0) break;
          t--;
        } else
          l !== "$" && l !== "$?" && l !== "$~" && l !== "$!" || t++;
      l = n;
    } while (l);
  }
  function Gf(t) {
    var e = t.firstChild;
    for (e && e.nodeType === 10 && (e = e.nextSibling); e; ) {
      var l = e;
      switch (e = e.nextSibling, l.nodeName) {
        case "HTML":
        case "HEAD":
        case "BODY":
          Gf(l), Na(l);
          continue;
        case "SCRIPT":
        case "STYLE":
          continue;
        case "LINK":
          if (l.rel.toLowerCase() === "stylesheet") continue;
      }
      t.removeChild(l);
    }
  }
  function Gm(t, e, l, n) {
    for (; t.nodeType === 1; ) {
      var a = l;
      if (t.nodeName.toLowerCase() !== e.toLowerCase()) {
        if (!n && (t.nodeName !== "INPUT" || t.type !== "hidden"))
          break;
      } else if (n) {
        if (!t[hn])
          switch (e) {
            case "meta":
              if (!t.hasAttribute("itemprop")) break;
              return t;
            case "link":
              if (u = t.getAttribute("rel"), u === "stylesheet" && t.hasAttribute("data-precedence"))
                break;
              if (u !== a.rel || t.getAttribute("href") !== (a.href == null || a.href === "" ? null : a.href) || t.getAttribute("crossorigin") !== (a.crossOrigin == null ? null : a.crossOrigin) || t.getAttribute("title") !== (a.title == null ? null : a.title))
                break;
              return t;
            case "style":
              if (t.hasAttribute("data-precedence")) break;
              return t;
            case "script":
              if (u = t.getAttribute("src"), (u !== (a.src == null ? null : a.src) || t.getAttribute("type") !== (a.type == null ? null : a.type) || t.getAttribute("crossorigin") !== (a.crossOrigin == null ? null : a.crossOrigin)) && u && t.hasAttribute("async") && !t.hasAttribute("itemprop"))
                break;
              return t;
            default:
              return t;
          }
      } else if (e === "input" && t.type === "hidden") {
        var u = a.name == null ? null : "" + a.name;
        if (a.type === "hidden" && t.getAttribute("name") === u)
          return t;
      } else return t;
      if (t = el(t.nextSibling), t === null) break;
    }
    return null;
  }
  function qm(t, e, l) {
    if (e === "") return null;
    for (; t.nodeType !== 3; )
      if ((t.nodeType !== 1 || t.nodeName !== "INPUT" || t.type !== "hidden") && !l || (t = el(t.nextSibling), t === null)) return null;
    return t;
  }
  function rd(t, e) {
    for (; t.nodeType !== 8; )
      if ((t.nodeType !== 1 || t.nodeName !== "INPUT" || t.type !== "hidden") && !e || (t = el(t.nextSibling), t === null)) return null;
    return t;
  }
  function qf(t) {
    return t.data === "$?" || t.data === "$~";
  }
  function Yf(t) {
    return t.data === "$!" || t.data === "$?" && t.ownerDocument.readyState !== "loading";
  }
  function Ym(t, e) {
    var l = t.ownerDocument;
    if (t.data === "$~") t._reactRetry = e;
    else if (t.data !== "$?" || l.readyState !== "loading")
      e();
    else {
      var n = function() {
        e(), l.removeEventListener("DOMContentLoaded", n);
      };
      l.addEventListener("DOMContentLoaded", n), t._reactRetry = n;
    }
  }
  function el(t) {
    for (; t != null; t = t.nextSibling) {
      var e = t.nodeType;
      if (e === 1 || e === 3) break;
      if (e === 8) {
        if (e = t.data, e === "$" || e === "$!" || e === "$?" || e === "$~" || e === "&" || e === "F!" || e === "F")
          break;
        if (e === "/$" || e === "/&") return null;
      }
    }
    return t;
  }
  var wf = null;
  function dd(t) {
    t = t.nextSibling;
    for (var e = 0; t; ) {
      if (t.nodeType === 8) {
        var l = t.data;
        if (l === "/$" || l === "/&") {
          if (e === 0)
            return el(t.nextSibling);
          e--;
        } else
          l !== "$" && l !== "$!" && l !== "$?" && l !== "$~" && l !== "&" || e++;
      }
      t = t.nextSibling;
    }
    return null;
  }
  function gd(t) {
    t = t.previousSibling;
    for (var e = 0; t; ) {
      if (t.nodeType === 8) {
        var l = t.data;
        if (l === "$" || l === "$!" || l === "$?" || l === "$~" || l === "&") {
          if (e === 0) return t;
          e--;
        } else l !== "/$" && l !== "/&" || e++;
      }
      t = t.previousSibling;
    }
    return null;
  }
  function md(t, e, l) {
    switch (e = Mi(l), t) {
      case "html":
        if (t = e.documentElement, !t) throw Error(r(452));
        return t;
      case "head":
        if (t = e.head, !t) throw Error(r(453));
        return t;
      case "body":
        if (t = e.body, !t) throw Error(r(454));
        return t;
      default:
        throw Error(r(451));
    }
  }
  function ru(t) {
    for (var e = t.attributes; e.length; )
      t.removeAttributeNode(e[0]);
    Na(t);
  }
  var ll = /* @__PURE__ */ new Map(), hd = /* @__PURE__ */ new Set();
  function Ri(t) {
    return typeof t.getRootNode == "function" ? t.getRootNode() : t.nodeType === 9 ? t : t.ownerDocument;
  }
  var Bl = U.d;
  U.d = {
    f: wm,
    r: Xm,
    D: Zm,
    C: jm,
    L: Qm,
    m: Km,
    X: km,
    S: Vm,
    M: Jm
  };
  function wm() {
    var t = Bl.f(), e = Ei();
    return t || e;
  }
  function Xm(t) {
    var e = bl(t);
    e !== null && e.tag === 5 && e.type === "form" ? Uo(e) : Bl.r(t);
  }
  var ha = typeof document > "u" ? null : document;
  function bd(t, e, l) {
    var n = ha;
    if (n && typeof e == "string" && e) {
      var a = De(e);
      a = 'link[rel="' + t + '"][href="' + a + '"]', typeof l == "string" && (a += '[crossorigin="' + l + '"]'), hd.has(a) || (hd.add(a), t = { rel: t, crossOrigin: l, href: e }, n.querySelector(a) === null && (e = n.createElement("link"), pe(e, "link", t), ae(e), n.head.appendChild(e)));
    }
  }
  function Zm(t) {
    Bl.D(t), bd("dns-prefetch", t, null);
  }
  function jm(t, e) {
    Bl.C(t, e), bd("preconnect", t, e);
  }
  function Qm(t, e, l) {
    Bl.L(t, e, l);
    var n = ha;
    if (n && t && e) {
      var a = 'link[rel="preload"][as="' + De(e) + '"]';
      e === "image" && l && l.imageSrcSet ? (a += '[imagesrcset="' + De(
        l.imageSrcSet
      ) + '"]', typeof l.imageSizes == "string" && (a += '[imagesizes="' + De(
        l.imageSizes
      ) + '"]')) : a += '[href="' + De(t) + '"]';
      var u = a;
      switch (e) {
        case "style":
          u = ba(t);
          break;
        case "script":
          u = ya(t);
      }
      ll.has(u) || (t = H(
        {
          rel: "preload",
          href: e === "image" && l && l.imageSrcSet ? void 0 : t,
          as: e
        },
        l
      ), ll.set(u, t), n.querySelector(a) !== null || e === "style" && n.querySelector(du(u)) || e === "script" && n.querySelector(gu(u)) || (e = n.createElement("link"), pe(e, "link", t), ae(e), n.head.appendChild(e)));
    }
  }
  function Km(t, e) {
    Bl.m(t, e);
    var l = ha;
    if (l && t) {
      var n = e && typeof e.as == "string" ? e.as : "script", a = 'link[rel="modulepreload"][as="' + De(n) + '"][href="' + De(t) + '"]', u = a;
      switch (n) {
        case "audioworklet":
        case "paintworklet":
        case "serviceworker":
        case "sharedworker":
        case "worker":
        case "script":
          u = ya(t);
      }
      if (!ll.has(u) && (t = H({ rel: "modulepreload", href: t }, e), ll.set(u, t), l.querySelector(a) === null)) {
        switch (n) {
          case "audioworklet":
          case "paintworklet":
          case "serviceworker":
          case "sharedworker":
          case "worker":
          case "script":
            if (l.querySelector(gu(u)))
              return;
        }
        n = l.createElement("link"), pe(n, "link", t), ae(n), l.head.appendChild(n);
      }
    }
  }
  function Vm(t, e, l) {
    Bl.S(t, e, l);
    var n = ha;
    if (n && t) {
      var a = Gl(n).hoistableStyles, u = ba(t);
      e = e || "default";
      var i = a.get(u);
      if (!i) {
        var c = { loading: 0, preload: null };
        if (i = n.querySelector(
          du(u)
        ))
          c.loading = 5;
        else {
          t = H(
            { rel: "stylesheet", href: t, "data-precedence": e },
            l
          ), (l = ll.get(u)) && Xf(t, l);
          var f = i = n.createElement("link");
          ae(f), pe(f, "link", t), f._p = new Promise(function(b, S) {
            f.onload = b, f.onerror = S;
          }), f.addEventListener("load", function() {
            c.loading |= 1;
          }), f.addEventListener("error", function() {
            c.loading |= 2;
          }), c.loading |= 4, zi(i, e, n);
        }
        i = {
          type: "stylesheet",
          instance: i,
          count: 1,
          state: c
        }, a.set(u, i);
      }
    }
  }
  function km(t, e) {
    Bl.X(t, e);
    var l = ha;
    if (l && t) {
      var n = Gl(l).hoistableScripts, a = ya(t), u = n.get(a);
      u || (u = l.querySelector(gu(a)), u || (t = H({ src: t, async: !0 }, e), (e = ll.get(a)) && Zf(t, e), u = l.createElement("script"), ae(u), pe(u, "link", t), l.head.appendChild(u)), u = {
        type: "script",
        instance: u,
        count: 1,
        state: null
      }, n.set(a, u));
    }
  }
  function Jm(t, e) {
    Bl.M(t, e);
    var l = ha;
    if (l && t) {
      var n = Gl(l).hoistableScripts, a = ya(t), u = n.get(a);
      u || (u = l.querySelector(gu(a)), u || (t = H({ src: t, async: !0, type: "module" }, e), (e = ll.get(a)) && Zf(t, e), u = l.createElement("script"), ae(u), pe(u, "link", t), l.head.appendChild(u)), u = {
        type: "script",
        instance: u,
        count: 1,
        state: null
      }, n.set(a, u));
    }
  }
  function yd(t, e, l, n) {
    var a = (a = ot.current) ? Ri(a) : null;
    if (!a) throw Error(r(446));
    switch (t) {
      case "meta":
      case "title":
        return null;
      case "style":
        return typeof l.precedence == "string" && typeof l.href == "string" ? (e = ba(l.href), l = Gl(
          a
        ).hoistableStyles, n = l.get(e), n || (n = {
          type: "style",
          instance: null,
          count: 0,
          state: null
        }, l.set(e, n)), n) : { type: "void", instance: null, count: 0, state: null };
      case "link":
        if (l.rel === "stylesheet" && typeof l.href == "string" && typeof l.precedence == "string") {
          t = ba(l.href);
          var u = Gl(
            a
          ).hoistableStyles, i = u.get(t);
          if (i || (a = a.ownerDocument || a, i = {
            type: "stylesheet",
            instance: null,
            count: 0,
            state: { loading: 0, preload: null }
          }, u.set(t, i), (u = a.querySelector(
            du(t)
          )) && !u._p && (i.instance = u, i.state.loading = 5), ll.has(t) || (l = {
            rel: "preload",
            as: "style",
            href: l.href,
            crossOrigin: l.crossOrigin,
            integrity: l.integrity,
            media: l.media,
            hrefLang: l.hrefLang,
            referrerPolicy: l.referrerPolicy
          }, ll.set(t, l), u || $m(
            a,
            t,
            l,
            i.state
          ))), e && n === null)
            throw Error(r(528, ""));
          return i;
        }
        if (e && n !== null)
          throw Error(r(529, ""));
        return null;
      case "script":
        return e = l.async, l = l.src, typeof l == "string" && e && typeof e != "function" && typeof e != "symbol" ? (e = ya(l), l = Gl(
          a
        ).hoistableScripts, n = l.get(e), n || (n = {
          type: "script",
          instance: null,
          count: 0,
          state: null
        }, l.set(e, n)), n) : { type: "void", instance: null, count: 0, state: null };
      default:
        throw Error(r(444, t));
    }
  }
  function ba(t) {
    return 'href="' + De(t) + '"';
  }
  function du(t) {
    return 'link[rel="stylesheet"][' + t + "]";
  }
  function vd(t) {
    return H({}, t, {
      "data-precedence": t.precedence,
      precedence: null
    });
  }
  function $m(t, e, l, n) {
    t.querySelector('link[rel="preload"][as="style"][' + e + "]") ? n.loading = 1 : (e = t.createElement("link"), n.preload = e, e.addEventListener("load", function() {
      return n.loading |= 1;
    }), e.addEventListener("error", function() {
      return n.loading |= 2;
    }), pe(e, "link", l), ae(e), t.head.appendChild(e));
  }
  function ya(t) {
    return '[src="' + De(t) + '"]';
  }
  function gu(t) {
    return "script[async]" + t;
  }
  function Ed(t, e, l) {
    if (e.count++, e.instance === null)
      switch (e.type) {
        case "style":
          var n = t.querySelector(
            'style[data-href~="' + De(l.href) + '"]'
          );
          if (n)
            return e.instance = n, ae(n), n;
          var a = H({}, l, {
            "data-href": l.href,
            "data-precedence": l.precedence,
            href: null,
            precedence: null
          });
          return n = (t.ownerDocument || t).createElement(
            "style"
          ), ae(n), pe(n, "style", a), zi(n, l.precedence, t), e.instance = n;
        case "stylesheet":
          a = ba(l.href);
          var u = t.querySelector(
            du(a)
          );
          if (u)
            return e.state.loading |= 4, e.instance = u, ae(u), u;
          n = vd(l), (a = ll.get(a)) && Xf(n, a), u = (t.ownerDocument || t).createElement("link"), ae(u);
          var i = u;
          return i._p = new Promise(function(c, f) {
            i.onload = c, i.onerror = f;
          }), pe(u, "link", n), e.state.loading |= 4, zi(u, l.precedence, t), e.instance = u;
        case "script":
          return u = ya(l.src), (a = t.querySelector(
            gu(u)
          )) ? (e.instance = a, ae(a), a) : (n = l, (a = ll.get(u)) && (n = H({}, l), Zf(n, a)), t = t.ownerDocument || t, a = t.createElement("script"), ae(a), pe(a, "link", n), t.head.appendChild(a), e.instance = a);
        case "void":
          return null;
        default:
          throw Error(r(443, e.type));
      }
    else
      e.type === "stylesheet" && !(e.state.loading & 4) && (n = e.instance, e.state.loading |= 4, zi(n, l.precedence, t));
    return e.instance;
  }
  function zi(t, e, l) {
    for (var n = l.querySelectorAll(
      'link[rel="stylesheet"][data-precedence],style[data-precedence]'
    ), a = n.length ? n[n.length - 1] : null, u = a, i = 0; i < n.length; i++) {
      var c = n[i];
      if (c.dataset.precedence === e) u = c;
      else if (u !== a) break;
    }
    u ? u.parentNode.insertBefore(t, u.nextSibling) : (e = l.nodeType === 9 ? l.head : l, e.insertBefore(t, e.firstChild));
  }
  function Xf(t, e) {
    t.crossOrigin == null && (t.crossOrigin = e.crossOrigin), t.referrerPolicy == null && (t.referrerPolicy = e.referrerPolicy), t.title == null && (t.title = e.title);
  }
  function Zf(t, e) {
    t.crossOrigin == null && (t.crossOrigin = e.crossOrigin), t.referrerPolicy == null && (t.referrerPolicy = e.referrerPolicy), t.integrity == null && (t.integrity = e.integrity);
  }
  var Di = null;
  function pd(t, e, l) {
    if (Di === null) {
      var n = /* @__PURE__ */ new Map(), a = Di = /* @__PURE__ */ new Map();
      a.set(l, n);
    } else
      a = Di, n = a.get(l), n || (n = /* @__PURE__ */ new Map(), a.set(l, n));
    if (n.has(t)) return n;
    for (n.set(t, null), l = l.getElementsByTagName(t), a = 0; a < l.length; a++) {
      var u = l[a];
      if (!(u[hn] || u[Pt] || t === "link" && u.getAttribute("rel") === "stylesheet") && u.namespaceURI !== "http://www.w3.org/2000/svg") {
        var i = u.getAttribute(e) || "";
        i = t + i;
        var c = n.get(i);
        c ? c.push(u) : n.set(i, [u]);
      }
    }
    return n;
  }
  function Sd(t, e, l) {
    t = t.ownerDocument || t, t.head.insertBefore(
      l,
      e === "title" ? t.querySelector("head > title") : null
    );
  }
  function Wm(t, e, l) {
    if (l === 1 || e.itemProp != null) return !1;
    switch (t) {
      case "meta":
      case "title":
        return !0;
      case "style":
        if (typeof e.precedence != "string" || typeof e.href != "string" || e.href === "")
          break;
        return !0;
      case "link":
        if (typeof e.rel != "string" || typeof e.href != "string" || e.href === "" || e.onLoad || e.onError)
          break;
        switch (e.rel) {
          case "stylesheet":
            return t = e.disabled, typeof e.precedence == "string" && t == null;
          default:
            return !0;
        }
      case "script":
        if (e.async && typeof e.async != "function" && typeof e.async != "symbol" && !e.onLoad && !e.onError && e.src && typeof e.src == "string")
          return !0;
    }
    return !1;
  }
  function _d(t) {
    return !(t.type === "stylesheet" && !(t.state.loading & 3));
  }
  function Im(t, e, l, n) {
    if (l.type === "stylesheet" && (typeof n.media != "string" || matchMedia(n.media).matches !== !1) && !(l.state.loading & 4)) {
      if (l.instance === null) {
        var a = ba(n.href), u = e.querySelector(
          du(a)
        );
        if (u) {
          e = u._p, e !== null && typeof e == "object" && typeof e.then == "function" && (t.count++, t = Ci.bind(t), e.then(t, t)), l.state.loading |= 4, l.instance = u, ae(u);
          return;
        }
        u = e.ownerDocument || e, n = vd(n), (a = ll.get(a)) && Xf(n, a), u = u.createElement("link"), ae(u);
        var i = u;
        i._p = new Promise(function(c, f) {
          i.onload = c, i.onerror = f;
        }), pe(u, "link", n), l.instance = u;
      }
      t.stylesheets === null && (t.stylesheets = /* @__PURE__ */ new Map()), t.stylesheets.set(l, e), (e = l.state.preload) && !(l.state.loading & 3) && (t.count++, l = Ci.bind(t), e.addEventListener("load", l), e.addEventListener("error", l));
    }
  }
  var jf = 0;
  function Fm(t, e) {
    return t.stylesheets && t.count === 0 && xi(t, t.stylesheets), 0 < t.count || 0 < t.imgCount ? function(l) {
      var n = setTimeout(function() {
        if (t.stylesheets && xi(t, t.stylesheets), t.unsuspend) {
          var u = t.unsuspend;
          t.unsuspend = null, u();
        }
      }, 6e4 + e);
      0 < t.imgBytes && jf === 0 && (jf = 62500 * Um());
      var a = setTimeout(
        function() {
          if (t.waitingForImages = !1, t.count === 0 && (t.stylesheets && xi(t, t.stylesheets), t.unsuspend)) {
            var u = t.unsuspend;
            t.unsuspend = null, u();
          }
        },
        (t.imgBytes > jf ? 50 : 800) + e
      );
      return t.unsuspend = l, function() {
        t.unsuspend = null, clearTimeout(n), clearTimeout(a);
      };
    } : null;
  }
  function Ci() {
    if (this.count--, this.count === 0 && (this.imgCount === 0 || !this.waitingForImages)) {
      if (this.stylesheets) xi(this, this.stylesheets);
      else if (this.unsuspend) {
        var t = this.unsuspend;
        this.unsuspend = null, t();
      }
    }
  }
  var Ui = null;
  function xi(t, e) {
    t.stylesheets = null, t.unsuspend !== null && (t.count++, Ui = /* @__PURE__ */ new Map(), e.forEach(Pm, t), Ui = null, Ci.call(t));
  }
  function Pm(t, e) {
    if (!(e.state.loading & 4)) {
      var l = Ui.get(t);
      if (l) var n = l.get(null);
      else {
        l = /* @__PURE__ */ new Map(), Ui.set(t, l);
        for (var a = t.querySelectorAll(
          "link[data-precedence],style[data-precedence]"
        ), u = 0; u < a.length; u++) {
          var i = a[u];
          (i.nodeName === "LINK" || i.getAttribute("media") !== "not all") && (l.set(i.dataset.precedence, i), n = i);
        }
        n && l.set(null, n);
      }
      a = e.instance, i = a.getAttribute("data-precedence"), u = l.get(i) || n, u === n && l.set(null, a), l.set(i, a), this.count++, n = Ci.bind(this), a.addEventListener("load", n), a.addEventListener("error", n), u ? u.parentNode.insertBefore(a, u.nextSibling) : (t = t.nodeType === 9 ? t.head : t, t.insertBefore(a, t.firstChild)), e.state.loading |= 4;
    }
  }
  var mu = {
    $$typeof: Nt,
    Provider: null,
    Consumer: null,
    _currentValue: x,
    _currentValue2: x,
    _threadCount: 0
  };
  function th(t, e, l, n, a, u, i, c, f) {
    this.tag = 1, this.containerInfo = t, this.pingCache = this.current = this.pendingChildren = null, this.timeoutHandle = -1, this.callbackNode = this.next = this.pendingContext = this.context = this.cancelPendingCommit = null, this.callbackPriority = 0, this.expirationTimes = wt(-1), this.entangledLanes = this.shellSuspendCounter = this.errorRecoveryDisabledLanes = this.expiredLanes = this.warmLanes = this.pingedLanes = this.suspendedLanes = this.pendingLanes = 0, this.entanglements = wt(0), this.hiddenUpdates = wt(null), this.identifierPrefix = n, this.onUncaughtError = a, this.onCaughtError = u, this.onRecoverableError = i, this.pooledCache = null, this.pooledCacheLanes = 0, this.formState = f, this.incompleteTransitions = /* @__PURE__ */ new Map();
  }
  function Td(t, e, l, n, a, u, i, c, f, b, S, O) {
    return t = new th(
      t,
      e,
      l,
      i,
      f,
      b,
      S,
      O,
      c
    ), e = 1, u === !0 && (e |= 24), u = Ze(3, null, null, e), t.current = u, u.stateNode = t, e = Sc(), e.refCount++, t.pooledCache = e, e.refCount++, u.memoizedState = {
      element: n,
      isDehydrated: l,
      cache: e
    }, Oc(u), t;
  }
  function Ad(t) {
    return t ? (t = Jn, t) : Jn;
  }
  function Od(t, e, l, n, a, u) {
    a = Ad(a), n.context === null ? n.context = a : n.pendingContext = a, n = Vl(e), n.payload = { element: l }, u = u === void 0 ? null : u, u !== null && (n.callback = u), l = kl(t, n, e), l !== null && (Le(l, t, e), Va(l, t, e));
  }
  function Nd(t, e) {
    if (t = t.memoizedState, t !== null && t.dehydrated !== null) {
      var l = t.retryLane;
      t.retryLane = l !== 0 && l < e ? l : e;
    }
  }
  function Qf(t, e) {
    Nd(t, e), (t = t.alternate) && Nd(t, e);
  }
  function Md(t) {
    if (t.tag === 13 || t.tag === 31) {
      var e = Sn(t, 67108864);
      e !== null && Le(e, t, 67108864), Qf(t, 67108864);
    }
  }
  function Rd(t) {
    if (t.tag === 13 || t.tag === 31) {
      var e = ke();
      e = Kt(e);
      var l = Sn(t, e);
      l !== null && Le(l, t, e), Qf(t, e);
    }
  }
  var Bi = !0;
  function eh(t, e, l, n) {
    var a = p.T;
    p.T = null;
    var u = U.p;
    try {
      U.p = 2, Kf(t, e, l, n);
    } finally {
      U.p = u, p.T = a;
    }
  }
  function lh(t, e, l, n) {
    var a = p.T;
    p.T = null;
    var u = U.p;
    try {
      U.p = 8, Kf(t, e, l, n);
    } finally {
      U.p = u, p.T = a;
    }
  }
  function Kf(t, e, l, n) {
    if (Bi) {
      var a = Vf(n);
      if (a === null)
        Cf(
          t,
          e,
          n,
          Hi,
          l
        ), Dd(t, n);
      else if (ah(
        a,
        t,
        e,
        l,
        n
      ))
        n.stopPropagation();
      else if (Dd(t, n), e & 4 && -1 < nh.indexOf(t)) {
        for (; a !== null; ) {
          var u = bl(a);
          if (u !== null)
            switch (u.tag) {
              case 3:
                if (u = u.stateNode, u.current.memoizedState.isDehydrated) {
                  var i = Re(u.pendingLanes);
                  if (i !== 0) {
                    var c = u;
                    for (c.pendingLanes |= 2, c.entangledLanes |= 2; i; ) {
                      var f = 1 << 31 - Oe(i);
                      c.entanglements[1] |= f, i &= ~f;
                    }
                    dl(u), !(Ot & 6) && (yi = It() + 500, fu(0));
                  }
                }
                break;
              case 31:
              case 13:
                c = Sn(u, 2), c !== null && Le(c, u, 2), Ei(), Qf(u, 2);
            }
          if (u = Vf(n), u === null && Cf(
            t,
            e,
            n,
            Hi,
            l
          ), u === a) break;
          a = u;
        }
        a !== null && n.stopPropagation();
      } else
        Cf(
          t,
          e,
          n,
          null,
          l
        );
    }
  }
  function Vf(t) {
    return t = it(t), kf(t);
  }
  var Hi = null;
  function kf(t) {
    if (Hi = null, t = Ne(t), t !== null) {
      var e = at(t);
      if (e === null) t = null;
      else {
        var l = e.tag;
        if (l === 13) {
          if (t = I(e), t !== null) return t;
          t = null;
        } else if (l === 31) {
          if (t = V(e), t !== null) return t;
          t = null;
        } else if (l === 3) {
          if (e.stateNode.current.memoizedState.isDehydrated)
            return e.tag === 3 ? e.stateNode.containerInfo : null;
          t = null;
        } else e !== t && (t = null);
      }
    }
    return Hi = t, null;
  }
  function zd(t) {
    switch (t) {
      case "beforetoggle":
      case "cancel":
      case "click":
      case "close":
      case "contextmenu":
      case "copy":
      case "cut":
      case "auxclick":
      case "dblclick":
      case "dragend":
      case "dragstart":
      case "drop":
      case "focusin":
      case "focusout":
      case "input":
      case "invalid":
      case "keydown":
      case "keypress":
      case "keyup":
      case "mousedown":
      case "mouseup":
      case "paste":
      case "pause":
      case "play":
      case "pointercancel":
      case "pointerdown":
      case "pointerup":
      case "ratechange":
      case "reset":
      case "resize":
      case "seeked":
      case "submit":
      case "toggle":
      case "touchcancel":
      case "touchend":
      case "touchstart":
      case "volumechange":
      case "change":
      case "selectionchange":
      case "textInput":
      case "compositionstart":
      case "compositionend":
      case "compositionupdate":
      case "beforeblur":
      case "afterblur":
      case "beforeinput":
      case "blur":
      case "fullscreenchange":
      case "focus":
      case "hashchange":
      case "popstate":
      case "select":
      case "selectstart":
        return 2;
      case "drag":
      case "dragenter":
      case "dragexit":
      case "dragleave":
      case "dragover":
      case "mousemove":
      case "mouseout":
      case "mouseover":
      case "pointermove":
      case "pointerout":
      case "pointerover":
      case "scroll":
      case "touchmove":
      case "wheel":
      case "mouseenter":
      case "mouseleave":
      case "pointerenter":
      case "pointerleave":
        return 8;
      case "message":
        switch (Tu()) {
          case ml:
            return 2;
          case on:
            return 8;
          case rn:
          case Qi:
            return 32;
          case Au:
            return 268435456;
          default:
            return 32;
        }
      default:
        return 32;
    }
  }
  var Jf = !1, an = null, un = null, cn = null, hu = /* @__PURE__ */ new Map(), bu = /* @__PURE__ */ new Map(), fn = [], nh = "mousedown mouseup touchcancel touchend touchstart auxclick dblclick pointercancel pointerdown pointerup dragend dragstart drop compositionend compositionstart keydown keypress keyup input textInput copy cut paste click change contextmenu reset".split(
    " "
  );
  function Dd(t, e) {
    switch (t) {
      case "focusin":
      case "focusout":
        an = null;
        break;
      case "dragenter":
      case "dragleave":
        un = null;
        break;
      case "mouseover":
      case "mouseout":
        cn = null;
        break;
      case "pointerover":
      case "pointerout":
        hu.delete(e.pointerId);
        break;
      case "gotpointercapture":
      case "lostpointercapture":
        bu.delete(e.pointerId);
    }
  }
  function yu(t, e, l, n, a, u) {
    return t === null || t.nativeEvent !== u ? (t = {
      blockedOn: e,
      domEventName: l,
      eventSystemFlags: n,
      nativeEvent: u,
      targetContainers: [a]
    }, e !== null && (e = bl(e), e !== null && Md(e)), t) : (t.eventSystemFlags |= n, e = t.targetContainers, a !== null && e.indexOf(a) === -1 && e.push(a), t);
  }
  function ah(t, e, l, n, a) {
    switch (e) {
      case "focusin":
        return an = yu(
          an,
          t,
          e,
          l,
          n,
          a
        ), !0;
      case "dragenter":
        return un = yu(
          un,
          t,
          e,
          l,
          n,
          a
        ), !0;
      case "mouseover":
        return cn = yu(
          cn,
          t,
          e,
          l,
          n,
          a
        ), !0;
      case "pointerover":
        var u = a.pointerId;
        return hu.set(
          u,
          yu(
            hu.get(u) || null,
            t,
            e,
            l,
            n,
            a
          )
        ), !0;
      case "gotpointercapture":
        return u = a.pointerId, bu.set(
          u,
          yu(
            bu.get(u) || null,
            t,
            e,
            l,
            n,
            a
          )
        ), !0;
    }
    return !1;
  }
  function Cd(t) {
    var e = Ne(t.target);
    if (e !== null) {
      var l = at(e);
      if (l !== null) {
        if (e = l.tag, e === 13) {
          if (e = I(l), e !== null) {
            t.blockedOn = e, qn(t.priority, function() {
              Rd(l);
            });
            return;
          }
        } else if (e === 31) {
          if (e = V(l), e !== null) {
            t.blockedOn = e, qn(t.priority, function() {
              Rd(l);
            });
            return;
          }
        } else if (e === 3 && l.stateNode.current.memoizedState.isDehydrated) {
          t.blockedOn = l.tag === 3 ? l.stateNode.containerInfo : null;
          return;
        }
      }
    }
    t.blockedOn = null;
  }
  function Li(t) {
    if (t.blockedOn !== null) return !1;
    for (var e = t.targetContainers; 0 < e.length; ) {
      var l = Vf(t.nativeEvent);
      if (l === null) {
        l = t.nativeEvent;
        var n = new l.constructor(
          l.type,
          l
        );
        w = n, l.target.dispatchEvent(n), w = null;
      } else
        return e = bl(l), e !== null && Md(e), t.blockedOn = l, !1;
      e.shift();
    }
    return !0;
  }
  function Ud(t, e, l) {
    Li(t) && l.delete(e);
  }
  function uh() {
    Jf = !1, an !== null && Li(an) && (an = null), un !== null && Li(un) && (un = null), cn !== null && Li(cn) && (cn = null), hu.forEach(Ud), bu.forEach(Ud);
  }
  function Gi(t, e) {
    t.blockedOn === e && (t.blockedOn = null, Jf || (Jf = !0, g.unstable_scheduleCallback(
      g.unstable_NormalPriority,
      uh
    )));
  }
  var qi = null;
  function xd(t) {
    qi !== t && (qi = t, g.unstable_scheduleCallback(
      g.unstable_NormalPriority,
      function() {
        qi === t && (qi = null);
        for (var e = 0; e < t.length; e += 3) {
          var l = t[e], n = t[e + 1], a = t[e + 2];
          if (typeof n != "function") {
            if (kf(n || l) === null)
              continue;
            break;
          }
          var u = bl(l);
          u !== null && (t.splice(e, 3), e -= 3, Kc(
            u,
            {
              pending: !0,
              data: a,
              method: l.method,
              action: n
            },
            n,
            a
          ));
        }
      }
    ));
  }
  function va(t) {
    function e(f) {
      return Gi(f, t);
    }
    an !== null && Gi(an, t), un !== null && Gi(un, t), cn !== null && Gi(cn, t), hu.forEach(e), bu.forEach(e);
    for (var l = 0; l < fn.length; l++) {
      var n = fn[l];
      n.blockedOn === t && (n.blockedOn = null);
    }
    for (; 0 < fn.length && (l = fn[0], l.blockedOn === null); )
      Cd(l), l.blockedOn === null && fn.shift();
    if (l = (t.ownerDocument || t).$$reactFormReplay, l != null)
      for (n = 0; n < l.length; n += 3) {
        var a = l[n], u = l[n + 1], i = a[_e] || null;
        if (typeof u == "function")
          i || xd(l);
        else if (i) {
          var c = null;
          if (u && u.hasAttribute("formAction")) {
            if (a = u, i = u[_e] || null)
              c = i.formAction;
            else if (kf(a) !== null) continue;
          } else c = i.action;
          typeof c == "function" ? l[n + 1] = c : (l.splice(n, 3), n -= 3), xd(l);
        }
      }
  }
  function Bd() {
    function t(u) {
      u.canIntercept && u.info === "react-transition" && u.intercept({
        handler: function() {
          return new Promise(function(i) {
            return a = i;
          });
        },
        focusReset: "manual",
        scroll: "manual"
      });
    }
    function e() {
      a !== null && (a(), a = null), n || setTimeout(l, 20);
    }
    function l() {
      if (!n && !navigation.transition) {
        var u = navigation.currentEntry;
        u && u.url != null && navigation.navigate(u.url, {
          state: u.getState(),
          info: "react-transition",
          history: "replace"
        });
      }
    }
    if (typeof navigation == "object") {
      var n = !1, a = null;
      return navigation.addEventListener("navigate", t), navigation.addEventListener("navigatesuccess", e), navigation.addEventListener("navigateerror", e), setTimeout(l, 100), function() {
        n = !0, navigation.removeEventListener("navigate", t), navigation.removeEventListener("navigatesuccess", e), navigation.removeEventListener("navigateerror", e), a !== null && (a(), a = null);
      };
    }
  }
  function $f(t) {
    this._internalRoot = t;
  }
  Yi.prototype.render = $f.prototype.render = function(t) {
    var e = this._internalRoot;
    if (e === null) throw Error(r(409));
    var l = e.current, n = ke();
    Od(l, n, t, e, null, null);
  }, Yi.prototype.unmount = $f.prototype.unmount = function() {
    var t = this._internalRoot;
    if (t !== null) {
      this._internalRoot = null;
      var e = t.containerInfo;
      Od(t.current, 2, null, t, null, null), Ei(), e[Hl] = null;
    }
  };
  function Yi(t) {
    this._internalRoot = t;
  }
  Yi.prototype.unstable_scheduleHydration = function(t) {
    if (t) {
      var e = Gn();
      t = { blockedOn: null, target: t, priority: e };
      for (var l = 0; l < fn.length && e !== 0 && e < fn[l].priority; l++) ;
      fn.splice(l, 0, t), l === 0 && Cd(t);
    }
  };
  var Hd = R.version;
  if (Hd !== "19.2.7")
    throw Error(
      r(
        527,
        Hd,
        "19.2.7"
      )
    );
  U.findDOMNode = function(t) {
    var e = t._reactInternals;
    if (e === void 0)
      throw typeof t.render == "function" ? Error(r(188)) : (t = Object.keys(t).join(","), Error(r(268, t)));
    return t = E(e), t = t !== null ? j(t) : null, t = t === null ? null : t.stateNode, t;
  };
  var ih = {
    bundleType: 0,
    version: "19.2.7",
    rendererPackageName: "react-dom",
    currentDispatcherRef: p,
    reconcilerVersion: "19.2.7"
  };
  if (typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ < "u") {
    var wi = __REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!wi.isDisabled && wi.supportsFiber)
      try {
        dn = wi.inject(
          ih
        ), Se = wi;
      } catch {
      }
  }
  return Eu.createRoot = function(t, e) {
    if (!J(t)) throw Error(r(299));
    var l = !1, n = "", a = Zo, u = jo, i = Qo;
    return e != null && (e.unstable_strictMode === !0 && (l = !0), e.identifierPrefix !== void 0 && (n = e.identifierPrefix), e.onUncaughtError !== void 0 && (a = e.onUncaughtError), e.onCaughtError !== void 0 && (u = e.onCaughtError), e.onRecoverableError !== void 0 && (i = e.onRecoverableError)), e = Td(
      t,
      1,
      !1,
      null,
      null,
      l,
      n,
      null,
      a,
      u,
      i,
      Bd
    ), t[Hl] = e.current, Df(t), new $f(e);
  }, Eu.hydrateRoot = function(t, e, l) {
    if (!J(t)) throw Error(r(299));
    var n = !1, a = "", u = Zo, i = jo, c = Qo, f = null;
    return l != null && (l.unstable_strictMode === !0 && (n = !0), l.identifierPrefix !== void 0 && (a = l.identifierPrefix), l.onUncaughtError !== void 0 && (u = l.onUncaughtError), l.onCaughtError !== void 0 && (i = l.onCaughtError), l.onRecoverableError !== void 0 && (c = l.onRecoverableError), l.formState !== void 0 && (f = l.formState)), e = Td(
      t,
      1,
      !0,
      e,
      l ?? null,
      n,
      a,
      f,
      u,
      i,
      c,
      Bd
    ), e.context = Ad(null), l = e.current, n = ke(), n = Kt(n), a = Vl(n), a.callback = null, kl(l, a, n), l = n, e.current.lanes = l, Lt(e, l), dl(e), t[Hl] = e.current, Df(t), new Yi(e);
  }, Eu.version = "19.2.7", Eu;
}
var Kd;
function bh() {
  if (Kd) return If.exports;
  Kd = 1;
  function g() {
    if (!(typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ > "u" || typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE != "function"))
      try {
        __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE(g);
      } catch (R) {
        console.error(R);
      }
  }
  return g(), If.exports = hh(), If.exports;
}
var Jh = bh(), yh = as();
const $h = /* @__PURE__ */ Jd(yh);
var ls, Vd;
function vh() {
  if (Vd) return ls;
  Vd = 1;
  function g(s) {
    return s instanceof Map ? s.clear = s.delete = s.set = function() {
      throw new Error("map is read-only");
    } : s instanceof Set && (s.add = s.clear = s.delete = function() {
      throw new Error("set is read-only");
    }), Object.freeze(s), Object.getOwnPropertyNames(s).forEach((T) => {
      const B = s[T], P = typeof B;
      (P === "object" || P === "function") && !Object.isFrozen(B) && g(B);
    }), s;
  }
  class R {
    /**
     * @param {CompiledMode} mode
     */
    constructor(T) {
      T.data === void 0 && (T.data = {}), this.data = T.data, this.isMatchIgnored = !1;
    }
    ignoreMatch() {
      this.isMatchIgnored = !0;
    }
  }
  function N(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
  }
  function r(s, ...T) {
    const B = /* @__PURE__ */ Object.create(null);
    for (const P in s)
      B[P] = s[P];
    return T.forEach(function(P) {
      for (const wt in P)
        B[wt] = P[wt];
    }), /** @type {T} */
    B;
  }
  const J = "</span>", at = (s) => !!s.scope, I = (s, { prefix: T }) => {
    if (s.startsWith("language:"))
      return s.replace("language:", "language-");
    if (s.includes(".")) {
      const B = s.split(".");
      return [
        `${T}${B.shift()}`,
        ...B.map((P, wt) => `${P}${"_".repeat(wt + 1)}`)
      ].join(" ");
    }
    return `${T}${s}`;
  };
  class V {
    /**
     * Creates a new HTMLRenderer
     *
     * @param {Tree} parseTree - the parse tree (must support `walk` API)
     * @param {{classPrefix: string}} options
     */
    constructor(T, B) {
      this.buffer = "", this.classPrefix = B.classPrefix, T.walk(this);
    }
    /**
     * Adds texts to the output stream
     *
     * @param {string} text */
    addText(T) {
      this.buffer += N(T);
    }
    /**
     * Adds a node open to the output stream (if needed)
     *
     * @param {Node} node */
    openNode(T) {
      if (!at(T)) return;
      const B = I(
        T.scope,
        { prefix: this.classPrefix }
      );
      this.span(B);
    }
    /**
     * Adds a node close to the output stream (if needed)
     *
     * @param {Node} node */
    closeNode(T) {
      at(T) && (this.buffer += J);
    }
    /**
     * returns the accumulated buffer
    */
    value() {
      return this.buffer;
    }
    // helpers
    /**
     * Builds a span element
     *
     * @param {string} className */
    span(T) {
      this.buffer += `<span class="${T}">`;
    }
  }
  const z = (s = {}) => {
    const T = { children: [] };
    return Object.assign(T, s), T;
  };
  class E {
    constructor() {
      this.rootNode = z(), this.stack = [this.rootNode];
    }
    get top() {
      return this.stack[this.stack.length - 1];
    }
    get root() {
      return this.rootNode;
    }
    /** @param {Node} node */
    add(T) {
      this.top.children.push(T);
    }
    /** @param {string} scope */
    openNode(T) {
      const B = z({ scope: T });
      this.add(B), this.stack.push(B);
    }
    closeNode() {
      if (this.stack.length > 1)
        return this.stack.pop();
    }
    closeAllNodes() {
      for (; this.closeNode(); ) ;
    }
    toJSON() {
      return JSON.stringify(this.rootNode, null, 4);
    }
    /**
     * @typedef { import("./html_renderer").Renderer } Renderer
     * @param {Renderer} builder
     */
    walk(T) {
      return this.constructor._walk(T, this.rootNode);
    }
    /**
     * @param {Renderer} builder
     * @param {Node} node
     */
    static _walk(T, B) {
      return typeof B == "string" ? T.addText(B) : B.children && (T.openNode(B), B.children.forEach((P) => this._walk(T, P)), T.closeNode(B)), T;
    }
    /**
     * @param {Node} node
     */
    static _collapse(T) {
      typeof T != "string" && T.children && (T.children.every((B) => typeof B == "string") ? T.children = [T.children.join("")] : T.children.forEach((B) => {
        E._collapse(B);
      }));
    }
  }
  class j extends E {
    /**
     * @param {*} options
     */
    constructor(T) {
      super(), this.options = T;
    }
    /**
     * @param {string} text
     */
    addText(T) {
      T !== "" && this.add(T);
    }
    /** @param {string} scope */
    startScope(T) {
      this.openNode(T);
    }
    endScope() {
      this.closeNode();
    }
    /**
     * @param {Emitter & {root: DataNode}} emitter
     * @param {string} name
     */
    __addSublanguage(T, B) {
      const P = T.root;
      B && (P.scope = `language:${B}`), this.add(P);
    }
    toHTML() {
      return new V(this, this.options).value();
    }
    finalize() {
      return this.closeAllNodes(), !0;
    }
  }
  function H(s) {
    return s ? typeof s == "string" ? s : s.source : null;
  }
  function Z(s) {
    return F("(?=", s, ")");
  }
  function ut(s) {
    return F("(?:", s, ")*");
  }
  function rt(s) {
    return F("(?:", s, ")?");
  }
  function F(...s) {
    return s.map((B) => H(B)).join("");
  }
  function Mt(s) {
    const T = s[s.length - 1];
    return typeof T == "object" && T.constructor === Object ? (s.splice(s.length - 1, 1), T) : {};
  }
  function ht(...s) {
    return "(" + (Mt(s).capture ? "" : "?:") + s.map((P) => H(P)).join("|") + ")";
  }
  function Ht(s) {
    return new RegExp(s.toString() + "|").exec("").length - 1;
  }
  function Nt(s, T) {
    const B = s && s.exec(T);
    return B && B.index === 0;
  }
  const jt = new RegExp(ht(
    /\[(?:[^\\\]]|\\.)*\]/,
    // a character class, inside which ( and \ lose their meaning
    /\(\?<(?![=!])[^>]+>/,
    // a named capture group `(?<name>` (not a lookbehind `(?<=` / `(?<!`)
    /\(\?'[^']+'/,
    // a named capture group `(?'name'`
    /\(\??/,
    // an opening parenthesis, capturing or non-capturing / lookahead
    /\\([1-9][0-9]*)/,
    // a backreference like `\1`
    /\\./
    // any other escape sequence
  ));
  function St(s, { joinWith: T }) {
    let B = 0;
    return s.map((P) => {
      B += 1;
      const wt = B;
      let Lt = H(P), Y = "";
      for (; Lt.length > 0; ) {
        const L = jt.exec(Lt);
        if (!L) {
          Y += Lt;
          break;
        }
        Y += Lt.substring(0, L.index), Lt = Lt.substring(L.index + L[0].length), L[0][0] === "\\" && L[1] ? Y += "\\" + String(Number(L[1]) + wt) : (Y += L[0], (L[0] === "(" || /^\(\?[<']/.test(L[0])) && B++);
      }
      return Y;
    }).map((P) => `(${P})`).join(T);
  }
  const pt = /\b\B/, tt = "[a-zA-Z]\\w*", qt = "[a-zA-Z_]\\w*", Qt = "\\b\\d+(\\.\\d+)?", Ge = "(-?)(\\b0[xX][a-fA-F0-9]+|(\\b\\d+(\\.\\d*)?|\\.\\d+)([eE][-+]?\\d+)?)", ge = "\\b(0b[01]+)", ne = "!|!=|!==|%|%=|&|&&|&=|\\*|\\*=|\\+|\\+=|,|-|-=|/=|/|:|;|<<|<<=|<=|<|===|==|=|>>>=|>>=|>=|>>>|>>|>|\\?|\\[|\\{|\\(|\\^|\\^=|\\||\\|=|\\|\\||~", qe = (s = {}) => {
    const T = /^#![ ]*\//;
    return s.binary && (s.begin = F(
      T,
      /.*\b/,
      s.binary,
      /\b.*/
    )), r({
      scope: "meta",
      begin: T,
      end: /$/,
      relevance: 0,
      /** @type {ModeCallback} */
      "on:begin": (B, P) => {
        B.index !== 0 && P.ignoreMatch();
      }
    }, s);
  }, oe = {
    begin: "\\\\[\\s\\S]",
    relevance: 0
  }, me = {
    scope: "string",
    begin: "'",
    end: "'",
    illegal: "\\n",
    contains: [oe]
  }, p = {
    scope: "string",
    begin: '"',
    end: '"',
    illegal: "\\n",
    contains: [oe]
  }, U = {
    begin: /\b(a|an|the|are|I'm|isn't|don't|doesn't|won't|but|just|should|pretty|simply|enough|gonna|going|wtf|so|such|will|you|your|they|like|more)\b/
  }, x = function(s, T, B = {}) {
    const P = r(
      {
        scope: "comment",
        begin: s,
        end: T,
        contains: []
      },
      B
    );
    P.contains.push({
      scope: "doctag",
      // hack to avoid the space from being included. the space is necessary to
      // match here to prevent the plain text rule below from gobbling up doctags
      begin: "[ ]*(?=(TODO|FIXME|NOTE|BUG|OPTIMIZE|HACK|XXX):)",
      end: /(TODO|FIXME|NOTE|BUG|OPTIMIZE|HACK|XXX):/,
      excludeBegin: !0,
      relevance: 0
    });
    const wt = ht(
      // list of common 1 and 2 letter words in English
      "I",
      "a",
      "is",
      "so",
      "us",
      "to",
      "at",
      "if",
      "in",
      "it",
      "on",
      // note: this is not an exhaustive list of contractions, just popular ones
      /[A-Za-z]+['](d|ve|re|ll|t|s|n)/,
      // contractions - can't we'd they're let's, etc
      /[A-Za-z]+[-][a-z]+/,
      // `no-way`, etc.
      /[A-Za-z][a-z]{2,}/
      // allow capitalized words at beginning of sentences
    );
    return P.contains.push(
      {
        // TODO: how to include ", (, ) without breaking grammars that use these for
        // comment delimiters?
        // begin: /[ ]+([()"]?([A-Za-z'-]{3,}|is|a|I|so|us|[tT][oO]|at|if|in|it|on)[.]?[()":]?([.][ ]|[ ]|\))){3}/
        // ---
        // this tries to find sequences of 3 english words in a row (without any
        // "programming" type syntax) this gives us a strong signal that we've
        // TRULY found a comment - vs perhaps scanning with the wrong language.
        // It's possible to find something that LOOKS like the start of the
        // comment - but then if there is no readable text - good chance it is a
        // false match and not a comment.
        //
        // for a visual example please see:
        // https://github.com/highlightjs/highlight.js/issues/2827
        begin: F(
          /[ ]+/,
          // necessary to prevent us gobbling up doctags like /* @author Bob Mcgill */
          "(",
          wt,
          /[.]?[:]?([.][ ]|[ ])/,
          "){3}"
        )
        // look for 3 words in a row
      }
    ), P;
  }, et = x("//", "$"), ft = x("/\\*", "\\*/"), o = x("#", "$"), _ = {
    scope: "number",
    begin: Qt,
    relevance: 0
  }, C = {
    scope: "number",
    begin: Ge,
    relevance: 0
  }, q = {
    scope: "number",
    begin: ge,
    relevance: 0
  }, lt = {
    scope: "regexp",
    begin: /\/(?=[^/\n]*\/)/,
    end: /\/[gimuy]*/,
    contains: [
      oe,
      {
        begin: /\[/,
        end: /\]/,
        relevance: 0,
        contains: [oe]
      }
    ]
  }, ot = {
    scope: "title",
    begin: tt,
    relevance: 0
  }, _t = {
    scope: "title",
    begin: qt,
    relevance: 0
  }, he = {
    // excludes method names from keyword processing
    begin: "\\.\\s*" + qt,
    relevance: 0
  };
  var il = /* @__PURE__ */ Object.freeze({
    __proto__: null,
    APOS_STRING_MODE: me,
    BACKSLASH_ESCAPE: oe,
    BINARY_NUMBER_MODE: q,
    BINARY_NUMBER_RE: ge,
    COMMENT: x,
    C_BLOCK_COMMENT_MODE: ft,
    C_LINE_COMMENT_MODE: et,
    C_NUMBER_MODE: C,
    C_NUMBER_RE: Ge,
    END_SAME_AS_BEGIN: function(s) {
      return Object.assign(
        s,
        {
          /** @type {ModeCallback} */
          "on:begin": (T, B) => {
            B.data._beginMatch = T[1];
          },
          /** @type {ModeCallback} */
          "on:end": (T, B) => {
            B.data._beginMatch !== T[1] && B.ignoreMatch();
          }
        }
      );
    },
    HASH_COMMENT_MODE: o,
    IDENT_RE: tt,
    MATCH_NOTHING_RE: pt,
    METHOD_GUARD: he,
    NUMBER_MODE: _,
    NUMBER_RE: Qt,
    PHRASAL_WORDS_MODE: U,
    QUOTE_STRING_MODE: p,
    REGEXP_MODE: lt,
    RE_STARTERS_RE: ne,
    SHEBANG: qe,
    TITLE_MODE: ot,
    UNDERSCORE_IDENT_RE: qt,
    UNDERSCORE_TITLE_MODE: _t
  });
  function Bn(s, T) {
    s.input[s.index - 1] === "." && T.ignoreMatch();
  }
  function Ea(s, T) {
    s.className !== void 0 && (s.scope = s.className, delete s.className);
  }
  function pu(s, T) {
    T && s.beginKeywords && (s.begin = "\\b(" + s.beginKeywords.split(" ").join("|") + ")(?!\\.)(?=\\b|\\s)", s.__beforeBegin = Bn, s.keywords = s.keywords || s.beginKeywords, delete s.beginKeywords, s.relevance === void 0 && (s.relevance = 0));
  }
  function gl(s, T) {
    Array.isArray(s.illegal) && (s.illegal = ht(...s.illegal));
  }
  function pa(s, T) {
    if (s.match) {
      if (s.begin || s.end) throw new Error("begin & end are not supported with match");
      s.begin = s.match, delete s.match;
    }
  }
  function Sa(s, T) {
    s.relevance === void 0 && (s.relevance = 1);
  }
  const Zi = (s, T) => {
    if (!s.beforeMatch) return;
    if (s.starts) throw new Error("beforeMatch cannot be used with starts");
    const B = Object.assign({}, s);
    Object.keys(s).forEach((P) => {
      delete s[P];
    }), s.keywords = B.keywords, s.begin = F(B.beforeMatch, Z(B.begin)), s.starts = {
      relevance: 0,
      contains: [
        Object.assign(B, { endsParent: !0 })
      ]
    }, s.relevance = 0, delete B.beforeMatch;
  }, Su = [
    "of",
    "and",
    "for",
    "in",
    "not",
    "or",
    "if",
    "then",
    "parent",
    // common variable name
    "list",
    // common variable name
    "value"
    // common variable name
  ], _a = "keyword";
  function Hn(s, T, B = _a) {
    const P = /* @__PURE__ */ Object.create(null);
    return typeof s == "string" ? wt(B, s.split(" ")) : Array.isArray(s) ? wt(B, s) : Object.keys(s).forEach(function(Lt) {
      Object.assign(
        P,
        Hn(s[Lt], T, Lt)
      );
    }), P;
    function wt(Lt, Y) {
      T && (Y = Y.map((L) => L.toLowerCase())), Y.forEach(function(L) {
        const W = L.split("|");
        P[W[0]] = [Lt, Ta(W[0], W[1])];
      });
    }
  }
  function Ta(s, T) {
    return T ? Number(T) : ji(s) ? 0 : 1;
  }
  function ji(s) {
    return Su.includes(s.toLowerCase());
  }
  const _u = {}, It = (s) => {
    console.error(s);
  }, Tu = (s, ...T) => {
    console.log(`WARN: ${s}`, ...T);
  }, ml = (s, T) => {
    _u[`${s}/${T}`] || (console.log(`Deprecated as of ${s}. ${T}`), _u[`${s}/${T}`] = !0);
  }, on = new Error();
  function rn(s, T, { key: B }) {
    let P = 0;
    const wt = s[B], Lt = {}, Y = {};
    for (let L = 1; L <= T.length; L++)
      Y[L + P] = wt[L], Lt[L + P] = !0, P += Ht(T[L - 1]);
    s[B] = Y, s[B]._emit = Lt, s[B]._multi = !0;
  }
  function Qi(s) {
    if (Array.isArray(s.begin)) {
      if (s.skip || s.excludeBegin || s.returnBegin)
        throw It("skip, excludeBegin, returnBegin not compatible with beginScope: {}"), on;
      if (typeof s.beginScope != "object" || s.beginScope === null)
        throw It("beginScope must be object"), on;
      rn(s, s.begin, { key: "beginScope" }), s.begin = St(s.begin, { joinWith: "" });
    }
  }
  function Au(s) {
    if (Array.isArray(s.end)) {
      if (s.skip || s.excludeEnd || s.returnEnd)
        throw It("skip, excludeEnd, returnEnd not compatible with endScope: {}"), on;
      if (typeof s.endScope != "object" || s.endScope === null)
        throw It("endScope must be object"), on;
      rn(s, s.end, { key: "endScope" }), s.end = St(s.end, { joinWith: "" });
    }
  }
  function Ki(s) {
    s.scope && typeof s.scope == "object" && s.scope !== null && (s.beginScope = s.scope, delete s.scope);
  }
  function Vi(s) {
    Ki(s), typeof s.beginScope == "string" && (s.beginScope = { _wrap: s.beginScope }), typeof s.endScope == "string" && (s.endScope = { _wrap: s.endScope }), Qi(s), Au(s);
  }
  function dn(s) {
    function T(Y, L) {
      return new RegExp(
        H(Y),
        "m" + (s.case_insensitive ? "i" : "") + (s.unicodeRegex ? "u" : "") + (L ? "g" : "")
      );
    }
    class B {
      constructor() {
        this.matchIndexes = {}, this.regexes = [], this.matchAt = 1, this.position = 0;
      }
      // @ts-ignore
      addRule(L, W) {
        W.position = this.position++, this.matchIndexes[this.matchAt] = W, this.regexes.push([W, L]), this.matchAt += Ht(L) + 1;
      }
      compile() {
        this.regexes.length === 0 && (this.exec = () => null);
        const L = this.regexes.map((W) => W[1]);
        this.matcherRe = T(St(L, { joinWith: "|" }), !0), this.lastIndex = 0;
      }
      /** @param {string} s */
      exec(L) {
        this.matcherRe.lastIndex = this.lastIndex;
        const W = this.matcherRe.exec(L);
        if (!W)
          return null;
        const Ft = W.findIndex((hl, Gn) => Gn > 0 && hl !== void 0), Kt = this.matchIndexes[Ft];
        return W.splice(0, Ft), Object.assign(W, Kt);
      }
    }
    class P {
      constructor() {
        this.rules = [], this.multiRegexes = [], this.count = 0, this.lastIndex = 0, this.regexIndex = 0;
      }
      // @ts-ignore
      getMatcher(L) {
        if (this.multiRegexes[L]) return this.multiRegexes[L];
        const W = new B();
        return this.rules.slice(L).forEach(([Ft, Kt]) => W.addRule(Ft, Kt)), W.compile(), this.multiRegexes[L] = W, W;
      }
      resumingScanAtSamePosition() {
        return this.regexIndex !== 0;
      }
      considerAll() {
        this.regexIndex = 0;
      }
      // @ts-ignore
      addRule(L, W) {
        this.rules.push([L, W]), W.type === "begin" && this.count++;
      }
      /** @param {string} s */
      exec(L) {
        const W = this.getMatcher(this.regexIndex);
        W.lastIndex = this.lastIndex;
        let Ft = W.exec(L);
        if (this.resumingScanAtSamePosition() && !(Ft && Ft.index === this.lastIndex)) {
          const Kt = this.getMatcher(0);
          Kt.lastIndex = this.lastIndex + 1, Ft = Kt.exec(L);
        }
        return Ft && (this.regexIndex += Ft.position + 1, this.regexIndex === this.count && this.considerAll()), Ft;
      }
    }
    function wt(Y) {
      const L = new P();
      return Y.contains.forEach((W) => L.addRule(W.begin, { rule: W, type: "begin" })), Y.terminatorEnd && L.addRule(Y.terminatorEnd, { type: "end" }), Y.illegal && L.addRule(Y.illegal, { type: "illegal" }), L;
    }
    function Lt(Y, L) {
      const W = (
        /** @type CompiledMode */
        Y
      );
      if (Y.isCompiled) return W;
      [
        Ea,
        // do this early so compiler extensions generally don't have to worry about
        // the distinction between match/begin
        pa,
        Vi,
        Zi
      ].forEach((Kt) => Kt(Y, L)), s.compilerExtensions.forEach((Kt) => Kt(Y, L)), Y.__beforeBegin = null, [
        pu,
        // do this later so compiler extensions that come earlier have access to the
        // raw array if they wanted to perhaps manipulate it, etc.
        gl,
        // default to 1 relevance if not specified
        Sa
      ].forEach((Kt) => Kt(Y, L)), Y.isCompiled = !0;
      let Ft = null;
      return typeof Y.keywords == "object" && Y.keywords.$pattern && (Y.keywords = Object.assign({}, Y.keywords), Ft = Y.keywords.$pattern, delete Y.keywords.$pattern), Ft = Ft || /\w+/, Y.keywords && (Y.keywords = Hn(Y.keywords, s.case_insensitive)), W.keywordPatternRe = T(Ft, !0), L && (Y.begin || (Y.begin = /\B|\b/), W.beginRe = T(W.begin), !Y.end && !Y.endsWithParent && (Y.end = /\B|\b/), Y.end && (W.endRe = T(W.end)), W.terminatorEnd = H(W.end) || "", Y.endsWithParent && L.terminatorEnd && (W.terminatorEnd += (Y.end ? "|" : "") + L.terminatorEnd)), Y.illegal && (W.illegalRe = T(
        /** @type {RegExp | string} */
        Y.illegal
      )), Y.contains || (Y.contains = []), Y.contains = [].concat(...Y.contains.map(function(Kt) {
        return cl(Kt === "self" ? Y : Kt);
      })), Y.contains.forEach(function(Kt) {
        Lt(
          /** @type Mode */
          Kt,
          W
        );
      }), Y.starts && Lt(Y.starts, L), W.matcher = wt(W), W;
    }
    if (s.compilerExtensions || (s.compilerExtensions = []), s.contains && s.contains.includes("self"))
      throw new Error("ERR: contains `self` is not supported at the top-level of a language.  See documentation.");
    return s.classNameAliases = r(s.classNameAliases || {}), Lt(
      /** @type Mode */
      s
    );
  }
  function Se(s) {
    return s ? s.endsWithParent || Se(s.starts) : !1;
  }
  function cl(s) {
    return s.variants && !s.cachedVariants && (s.cachedVariants = s.variants.map(function(T) {
      return r(s, { variants: null }, T);
    })), s.cachedVariants ? s.cachedVariants : Se(s) ? r(s, { starts: s.starts ? r(s.starts) : null }) : Object.isFrozen(s) ? r(s) : s;
  }
  var Oe = "11.12.0";
  class ki extends Error {
    constructor(T, B) {
      super(T), this.name = "HTMLInjectionError", this.html = B;
    }
  }
  const Aa = N, Ou = r, gn = Symbol("nomatch"), Ln = 7, mn = function(s) {
    const T = /* @__PURE__ */ Object.create(null), B = /* @__PURE__ */ Object.create(null), P = [];
    let wt = !0;
    const Lt = "Could not find the language '{}', did you forget to load/include a language module?", Y = { disableAutodetect: !0, name: "Plain text", contains: [] };
    let L = {
      ignoreUnescapedHTML: !1,
      throwUnescapedHTML: !1,
      noHighlightRe: /^(no-?highlight)$/i,
      languageDetectRe: /\blang(?:uage)?-([\w-]+)\b/i,
      classPrefix: "hljs-",
      cssSelector: "pre code",
      languages: null,
      // beta configuration options, subject to change, welcome to discuss
      // https://github.com/highlightjs/highlight.js/issues/1086
      __emitter: j
    };
    function W(M) {
      return L.noHighlightRe.test(M);
    }
    function Ft(M) {
      let Q = M.className + " ";
      Q += M.parentNode ? M.parentNode.className : "";
      const dt = L.languageDetectRe.exec(Q);
      if (dt) {
        const Rt = Ne(dt[1]);
        return Rt || (Tu(Lt.replace("{}", dt[1])), Tu("Falling back to no-highlight mode for this block.", M)), Rt ? dt[1] : "no-highlight";
      }
      return Q.split(/\s+/).find((Rt) => W(Rt) || Ne(Rt));
    }
    function Kt(M, Q, dt) {
      let Rt = "", te = "";
      typeof Q == "object" ? (Rt = M, dt = Q.ignoreIllegals, te = Q.language) : (ml("10.7.0", "highlight(lang, code, ...args) has been deprecated."), ml("10.7.0", `Please use highlight(code, options) instead.
https://github.com/highlightjs/highlight.js/issues/2277`), te = M, Rt = Q), dt === void 0 && (dt = !0);
      const Te = {
        code: Rt,
        language: te
      };
      bn("before:highlight", Te);
      const Ye = Te.result ? Te.result : hl(Te.language, Te.code, dt);
      return Ye.code = Te.code, bn("after:highlight", Ye), Ye;
    }
    function hl(M, Q, dt, Rt) {
      const te = /* @__PURE__ */ Object.create(null);
      function Te(D, w) {
        return D.keywords[w];
      }
      function Ye() {
        if (!$.keywords) {
          ue.addText(zt);
          return;
        }
        let D = 0;
        $.keywordPatternRe.lastIndex = 0;
        let w = $.keywordPatternRe.exec(zt), it = "";
        for (; w; ) {
          it += zt.substring(D, w.index);
          const bt = be.case_insensitive ? w[0].toLowerCase() : w[0], kt = Te($, bt);
          if (kt) {
            const [Je, Da] = kt;
            if (ue.addText(it), it = "", te[bt] = (te[bt] || 0) + 1, te[bt] <= Ln && (ql += Da), Je.startsWith("_"))
              it += w[0];
            else {
              const Uu = be.classNameAliases[Je] || Je;
              we(w[0], Uu);
            }
          } else
            it += w[0];
          D = $.keywordPatternRe.lastIndex, w = $.keywordPatternRe.exec(zt);
        }
        it += zt.substring(D), ue.addText(it);
      }
      function ze() {
        if (zt === "") return;
        let D = null;
        if (typeof $.subLanguage == "string") {
          if (!T[$.subLanguage]) {
            ue.addText(zt);
            return;
          }
          D = hl($.subLanguage, zt, !0, Cu[$.subLanguage]), Cu[$.subLanguage] = /** @type {CompiledMode} */
          D._top;
        } else
          D = qn(zt, $.subLanguage.length ? $.subLanguage : null);
        $.relevance > 0 && (ql += D.relevance), ue.__addSublanguage(D._emitter, D.language);
      }
      function Yt() {
        $.subLanguage != null ? ze() : Ye(), zt = "";
      }
      function we(D, w) {
        D !== "" && (ue.startScope(w), ue.addText(D), ue.endScope());
      }
      function zu(D, w) {
        let it = 1;
        const bt = w.length - 1;
        for (; it <= bt; ) {
          if (!D._emit[it]) {
            it++;
            continue;
          }
          const kt = be.classNameAliases[D[it]] || D[it], Je = w[it];
          kt ? we(Je, kt) : (zt = Je, Ye(), zt = ""), it++;
        }
      }
      function wn(D, w) {
        return D.scope && typeof D.scope == "string" && ue.openNode(be.classNameAliases[D.scope] || D.scope), D.beginScope && (D.beginScope._wrap ? (we(zt, be.classNameAliases[D.beginScope._wrap] || D.beginScope._wrap), zt = "") : D.beginScope._multi && (zu(D.beginScope, w), zt = "")), $ = Object.create(D, { parent: { value: $ } }), $;
      }
      function Ma(D, w, it) {
        let bt = Nt(D.endRe, it);
        if (bt) {
          if (D["on:end"]) {
            const kt = new R(D);
            D["on:end"](w, kt), kt.isMatchIgnored && (bt = !1);
          }
          if (bt) {
            for (; D.endsParent && D.parent; )
              D = D.parent;
            return D;
          }
        }
        if (D.endsWithParent)
          return Ma(D.parent, w, it);
      }
      function Xn(D) {
        return $.matcher.regexIndex === 0 ? (zt += D[0], 1) : (Yl = !0, 0);
      }
      function Ji(D) {
        const w = D[0], it = D.rule, bt = new R(it), kt = [it.__beforeBegin, it["on:begin"]];
        for (const Je of kt)
          if (Je && (Je(D, bt), bt.isMatchIgnored))
            return Xn(w);
        return it.skip ? zt += w : (it.excludeBegin && (zt += w), Yt(), !it.returnBegin && !it.excludeBegin && (zt = w)), wn(it, D), it.returnBegin ? 0 : w.length;
      }
      function De(D) {
        const w = D[0], it = Q.substring(D.index), bt = Ma($, D, it);
        if (!bt)
          return gn;
        const kt = $;
        $.endScope && $.endScope._wrap ? (Yt(), we(w, $.endScope._wrap)) : $.endScope && $.endScope._multi ? (Yt(), zu($.endScope, D)) : kt.skip ? zt += w : (kt.returnEnd || kt.excludeEnd || (zt += w), Yt(), kt.excludeEnd && (zt = w));
        do
          $.scope && ue.closeNode(), !$.skip && !$.subLanguage && (ql += $.relevance), $ = $.parent;
        while ($ !== bt.parent);
        return bt.starts && wn(bt.starts, D), kt.returnEnd ? 0 : w.length;
      }
      function Ra() {
        const D = [];
        for (let w = $; w !== be; w = w.parent)
          w.scope && D.unshift(w.scope);
        D.forEach((w) => ue.openNode(w));
      }
      let yn = {};
      function Zn(D, w) {
        const it = w && w[0];
        if (zt += D, it == null)
          return Yt(), 0;
        if (yn.type === "begin" && w.type === "end" && yn.index === w.index && it === "") {
          if (zt += Q.slice(w.index, w.index + 1), !wt) {
            const bt = new Error(`0 width match regex (${M})`);
            throw bt.languageName = M, bt.badRule = yn.rule, bt;
          }
          return 1;
        }
        if (yn = w, w.type === "begin")
          return Ji(w);
        if (w.type === "illegal" && !dt) {
          const bt = new Error('Illegal lexeme "' + it + '" for mode "' + ($.scope || "<unnamed>") + '"');
          throw bt.mode = $, bt;
        } else if (w.type === "end") {
          const bt = De(w);
          if (bt !== gn)
            return bt;
        }
        if (w.type === "illegal" && it === "")
          return w.index === Q.length || (zt += `
`), 1;
        if (za > 1e5 && za > w.index * 3)
          throw new Error("potential infinite loop, way more iterations than matches");
        return zt += it, it.length;
      }
      const be = Ne(M);
      if (!be)
        throw It(Lt.replace("{}", M)), new Error('Unknown language: "' + M + '"');
      const Du = dn(be);
      let jn = "", $ = Rt || Du;
      const Cu = {}, ue = new L.__emitter(L);
      Ra();
      let zt = "", ql = 0, vl = 0, za = 0, Yl = !1;
      try {
        if (be.__emitTokens)
          be.__emitTokens(Q, ue);
        else {
          for ($.matcher.considerAll(); ; ) {
            za++, Yl ? Yl = !1 : $.matcher.considerAll(), $.matcher.lastIndex = vl;
            const D = $.matcher.exec(Q);
            if (!D) break;
            const w = Q.substring(vl, D.index), it = Zn(w, D);
            vl = D.index + it;
          }
          Zn(Q.substring(vl));
        }
        return ue.finalize(), jn = ue.toHTML(), {
          language: M,
          value: jn,
          relevance: ql,
          illegal: !1,
          _emitter: ue,
          _top: $
        };
      } catch (D) {
        if (D.message && D.message.includes("Illegal"))
          return {
            language: M,
            value: Aa(Q),
            illegal: !0,
            relevance: 0,
            _illegalBy: {
              message: D.message,
              index: vl,
              context: Q.slice(vl - 100, vl + 100),
              mode: D.mode,
              resultSoFar: jn
            },
            _emitter: ue
          };
        if (wt)
          return {
            language: M,
            value: Aa(Q),
            illegal: !1,
            relevance: 0,
            errorRaised: D,
            _emitter: ue,
            _top: $
          };
        throw D;
      }
    }
    function Gn(M) {
      const Q = {
        value: Aa(M),
        illegal: !1,
        relevance: 0,
        _top: Y,
        _emitter: new L.__emitter(L)
      };
      return Q._emitter.addText(M), Q;
    }
    function qn(M, Q) {
      Q = Q || L.languages || Object.keys(T);
      const dt = Gn(M), Rt = Q.filter(Ne).filter(Ll).map(
        (Yt) => hl(Yt, M, !1)
      );
      Rt.unshift(dt);
      const te = Rt.sort((Yt, we) => {
        if (Yt.relevance !== we.relevance) return we.relevance - Yt.relevance;
        if (Yt.language && we.language) {
          if (Ne(Yt.language).supersetOf === we.language)
            return 1;
          if (Ne(we.language).supersetOf === Yt.language)
            return -1;
        }
        return 0;
      }), [Te, Ye] = te, ze = Te;
      return ze.secondBest = Ye, ze;
    }
    function fl(M, Q, dt) {
      const Rt = Q && B[Q] || dt;
      M.classList.add("hljs"), M.classList.add(`language-${Rt}`);
    }
    function Pt(M) {
      let Q = null;
      const dt = Ft(M);
      if (W(dt)) return;
      if (bn(
        "before:highlightElement",
        { el: M, language: dt }
      ), M.dataset.highlighted) {
        console.log("Element previously highlighted. To highlight again, first unset `dataset.highlighted`.", M);
        return;
      }
      if (M.children.length > 0 && (L.ignoreUnescapedHTML || (console.warn("One of your code blocks includes unescaped HTML. This is a potentially serious security risk."), console.warn("https://github.com/highlightjs/highlight.js/wiki/security"), console.warn("The element with unescaped HTML:"), console.warn(M)), L.throwUnescapedHTML))
        throw new ki(
          "One of your code blocks includes unescaped HTML.",
          M.innerHTML
        );
      Q = M;
      const Rt = Q.textContent, te = dt ? Kt(Rt, { language: dt, ignoreIllegals: !0 }) : qn(Rt);
      M.innerHTML = te.value, M.dataset.highlighted = "yes", fl(M, dt, te.language), M.result = {
        language: te.language,
        // TODO: remove with version 11.0
        re: te.relevance,
        relevance: te.relevance
      }, te.secondBest && (M.secondBest = {
        language: te.secondBest.language,
        relevance: te.secondBest.relevance
      }), bn("after:highlightElement", { el: M, result: te, text: Rt });
    }
    function _e(M) {
      L = Ou(L, M);
    }
    const Hl = () => {
      Yn(), ml("10.6.0", "initHighlighting() deprecated.  Use highlightAll() now.");
    };
    function Oa() {
      Yn(), ml("10.6.0", "initHighlightingOnLoad() deprecated.  Use highlightAll() now.");
    }
    let Nu = !1;
    function Yn() {
      function M() {
        Yn();
      }
      if (document.readyState === "loading") {
        Nu || window.addEventListener("DOMContentLoaded", M, !1), Nu = !0;
        return;
      }
      document.querySelectorAll(L.cssSelector).forEach(Pt);
    }
    function Mu(M, Q) {
      let dt = null;
      try {
        dt = Q(s);
      } catch (Rt) {
        if (It("Language definition for '{}' could not be registered.".replace("{}", M)), wt)
          It(Rt);
        else
          throw Rt;
        dt = Y;
      }
      dt.name || (dt.name = M), T[M] = dt, dt.rawDefinition = Q.bind(null, s), dt.aliases && bl(dt.aliases, { languageName: M });
    }
    function hn(M) {
      delete T[M];
      for (const Q of Object.keys(B))
        B[Q] === M && delete B[Q];
    }
    function Na() {
      return Object.keys(T);
    }
    function Ne(M) {
      return M = (M || "").toLowerCase(), T[M] || T[B[M]];
    }
    function bl(M, { languageName: Q }) {
      typeof M == "string" && (M = [M]), M.forEach((dt) => {
        B[dt.toLowerCase()] = Q;
      });
    }
    function Ll(M) {
      const Q = Ne(M);
      return Q && !Q.disableAutodetect;
    }
    function Gl(M) {
      M["before:highlightBlock"] && !M["before:highlightElement"] && (M["before:highlightElement"] = (Q) => {
        M["before:highlightBlock"](
          Object.assign({ block: Q.el }, Q)
        );
      }), M["after:highlightBlock"] && !M["after:highlightElement"] && (M["after:highlightElement"] = (Q) => {
        M["after:highlightBlock"](
          Object.assign({ block: Q.el }, Q)
        );
      });
    }
    function ae(M) {
      Gl(M), P.push(M);
    }
    function Ru(M) {
      const Q = P.indexOf(M);
      Q !== -1 && P.splice(Q, 1);
    }
    function bn(M, Q) {
      const dt = M;
      P.forEach(function(Rt) {
        Rt[dt] && Rt[dt](Q);
      });
    }
    function yl(M) {
      return ml("10.7.0", "highlightBlock will be removed entirely in v12.0"), ml("10.7.0", "Please use highlightElement now."), Pt(M);
    }
    Object.assign(s, {
      highlight: Kt,
      highlightAuto: qn,
      highlightAll: Yn,
      highlightElement: Pt,
      // TODO: Remove with v12 API
      highlightBlock: yl,
      configure: _e,
      initHighlighting: Hl,
      initHighlightingOnLoad: Oa,
      registerLanguage: Mu,
      unregisterLanguage: hn,
      listLanguages: Na,
      getLanguage: Ne,
      registerAliases: bl,
      autoDetection: Ll,
      inherit: Ou,
      addPlugin: ae,
      removePlugin: Ru
    }), s.debugMode = function() {
      wt = !1;
    }, s.safeMode = function() {
      wt = !0;
    }, s.versionString = Oe, s.regex = {
      concat: F,
      lookahead: Z,
      either: ht,
      optional: rt,
      anyNumberOfTimes: ut
    };
    for (const M in il)
      typeof il[M] == "object" && g(il[M]);
    return Object.assign(s, il), s;
  }, Re = mn({});
  return Re.newInstance = () => mn({}), ls = Re, Re.HighlightJS = Re, Re.default = Re, ls;
}
var Eh = /* @__PURE__ */ vh();
const ns = /* @__PURE__ */ Jd(Eh), kd = "[A-Za-z$_][0-9A-Za-z$_]*", ph = [
  "as",
  // for exports
  "in",
  "of",
  "if",
  "for",
  "while",
  "finally",
  "var",
  "new",
  "function",
  "do",
  "return",
  "void",
  "else",
  "break",
  "catch",
  "instanceof",
  "with",
  "throw",
  "case",
  "default",
  "try",
  "switch",
  "continue",
  "typeof",
  "delete",
  "let",
  "yield",
  "const",
  "class",
  // JS handles these with a special rule
  // "get",
  // "set",
  "debugger",
  "async",
  "await",
  "static",
  "import",
  "from",
  "export",
  "extends",
  // It's reached stage 3, which is "recommended for implementation":
  "using"
], Sh = [
  "true",
  "false",
  "null",
  "undefined",
  "NaN",
  "Infinity"
], $d = [
  // Fundamental objects
  "Object",
  "Function",
  "Boolean",
  "Symbol",
  // numbers and dates
  "Math",
  "Date",
  "Number",
  "BigInt",
  // text
  "String",
  "RegExp",
  // Indexed collections
  "Array",
  "Float32Array",
  "Float64Array",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Int32Array",
  "Uint16Array",
  "Uint32Array",
  "BigInt64Array",
  "BigUint64Array",
  // Keyed collections
  "Set",
  "Map",
  "WeakSet",
  "WeakMap",
  // Structured data
  "ArrayBuffer",
  "SharedArrayBuffer",
  "Atomics",
  "DataView",
  "JSON",
  // Control abstraction objects
  "Promise",
  "Generator",
  "GeneratorFunction",
  "AsyncFunction",
  // Reflection
  "Reflect",
  "Proxy",
  // Internationalization
  "Intl",
  // WebAssembly
  "WebAssembly"
], Wd = [
  "Error",
  "EvalError",
  "InternalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError"
], Id = [
  "setInterval",
  "setTimeout",
  "clearInterval",
  "clearTimeout",
  "require",
  "exports",
  "eval",
  "isFinite",
  "isNaN",
  "parseFloat",
  "parseInt",
  "decodeURI",
  "decodeURIComponent",
  "encodeURI",
  "encodeURIComponent",
  "escape",
  "unescape"
], _h = [
  "arguments",
  "this",
  "super",
  "console",
  "window",
  "document",
  "localStorage",
  "sessionStorage",
  "module",
  "self",
  "global"
  // Node.js
], Th = [].concat(
  Id,
  $d,
  Wd
);
function Ah(g) {
  const R = g.regex, N = (x, { after: et }) => {
    const ft = "</" + x[0].slice(1);
    return x.input.indexOf(ft, et) !== -1;
  }, r = kd, J = {
    begin: "<>",
    end: "</>"
  }, at = /<[A-Za-z0-9\\._:-]+\s*\/>/, I = {
    begin: /<[A-Za-z0-9\\._:-]+/,
    end: /\/[A-Za-z0-9\\._:-]+>|\/>/,
    /**
     * @param {RegExpMatchArray} match
     * @param {CallbackResponse} response
     */
    isTrulyOpeningTag: (x, et) => {
      const ft = x[0].length + x.index, o = x.input[ft];
      if (
        // HTML should not include another raw `<` inside a tag
        // nested type?
        // `<Array<Array<number>>`, etc.
        o === "<" || // the , gives away that this is not HTML
        // `<T, A extends keyof T, V>`
        o === ","
      ) {
        et.ignoreMatch();
        return;
      }
      o === ">" && (N(x, { after: ft }) || et.ignoreMatch());
      let _;
      const C = x.input.substring(ft);
      if (_ = C.match(/^\s*=/)) {
        et.ignoreMatch();
        return;
      }
      if ((_ = C.match(/^\s+extends\s+/)) && _.index === 0) {
        et.ignoreMatch();
        return;
      }
    }
  }, V = {
    $pattern: kd,
    keyword: ph,
    literal: Sh,
    built_in: Th,
    "variable.language": _h
  }, z = "[0-9](_?[0-9])*", E = `\\.(${z})`, j = "0|[1-9](_?[0-9])*|0[0-7]*[89][0-9]*", H = {
    className: "number",
    variants: [
      // DecimalLiteral
      { begin: `(\\b(${j})((${E})|\\.)?|(${E}))[eE][+-]?(${z})\\b` },
      { begin: `\\b(${j})\\b((${E})\\b|\\.)?|(${E})\\b` },
      // DecimalBigIntegerLiteral
      { begin: "\\b(0|[1-9](_?[0-9])*)n\\b" },
      // NonDecimalIntegerLiteral
      { begin: "\\b0[xX][0-9a-fA-F](_?[0-9a-fA-F])*n?\\b" },
      { begin: "\\b0[bB][0-1](_?[0-1])*n?\\b" },
      { begin: "\\b0[oO][0-7](_?[0-7])*n?\\b" },
      // LegacyOctalIntegerLiteral (does not include underscore separators)
      // https://tc39.es/ecma262/#sec-additional-syntax-numeric-literals
      { begin: "\\b0[0-7]+n?\\b" }
    ],
    relevance: 0
  }, Z = {
    className: "subst",
    begin: "\\$\\{",
    end: "\\}",
    keywords: V,
    contains: []
    // defined later
  }, ut = {
    begin: ".?html`",
    end: "",
    starts: {
      end: "`",
      returnEnd: !1,
      contains: [
        g.BACKSLASH_ESCAPE,
        Z
      ],
      subLanguage: "xml"
    }
  }, rt = {
    begin: ".?css`",
    end: "",
    starts: {
      end: "`",
      returnEnd: !1,
      contains: [
        g.BACKSLASH_ESCAPE,
        Z
      ],
      subLanguage: "css"
    }
  }, F = {
    begin: ".?gql`",
    end: "",
    starts: {
      end: "`",
      returnEnd: !1,
      contains: [
        g.BACKSLASH_ESCAPE,
        Z
      ],
      subLanguage: "graphql"
    }
  }, Mt = {
    className: "string",
    begin: "`",
    end: "`",
    contains: [
      g.BACKSLASH_ESCAPE,
      Z
    ]
  }, Ht = {
    className: "comment",
    variants: [
      g.COMMENT(
        /\/\*\*(?!\/)/,
        "\\*/",
        {
          relevance: 0,
          contains: [
            {
              begin: "(?=@[A-Za-z]+)",
              relevance: 0,
              contains: [
                {
                  className: "doctag",
                  begin: "@[A-Za-z]+"
                },
                {
                  className: "type",
                  begin: "\\{",
                  end: "\\}",
                  excludeEnd: !0,
                  excludeBegin: !0,
                  relevance: 0
                },
                {
                  className: "variable",
                  begin: r + "(?=\\s*(-)|$)",
                  endsParent: !0,
                  relevance: 0
                },
                // eat spaces (not newlines) so we can find
                // types or variables
                {
                  begin: /(?=[^\n])\s/,
                  relevance: 0
                }
              ]
            }
          ]
        }
      ),
      g.C_BLOCK_COMMENT_MODE,
      g.C_LINE_COMMENT_MODE
    ]
  }, Nt = [
    g.APOS_STRING_MODE,
    g.QUOTE_STRING_MODE,
    ut,
    rt,
    F,
    Mt,
    // Skip numbers when they are part of a variable name
    { match: /\$\d+/ },
    H
    // This is intentional:
    // See https://github.com/highlightjs/highlight.js/issues/3288
    // hljs.REGEXP_MODE
  ];
  Z.contains = Nt.concat({
    // we need to pair up {} inside our subst to prevent
    // it from ending too early by matching another }
    begin: /\{/,
    end: /\}/,
    keywords: V,
    contains: [
      "self"
    ].concat(Nt)
  });
  const jt = [].concat(Ht, Z.contains), St = jt.concat([
    // eat recursive parens in sub expressions
    {
      begin: /(\s*)\(/,
      end: /\)/,
      keywords: V,
      contains: ["self"].concat(jt)
    }
  ]), pt = {
    className: "params",
    // convert this to negative lookbehind in v12
    begin: /(\s*)\(/,
    // to match the parms with
    end: /\)/,
    excludeBegin: !0,
    excludeEnd: !0,
    keywords: V,
    contains: St
  }, tt = {
    variants: [
      // class Car extends vehicle
      {
        match: [
          /class/,
          /\s+/,
          r,
          /\s+/,
          /extends/,
          /\s+/,
          R.concat(r, "(", R.concat(/\./, r), ")*")
        ],
        scope: {
          1: "keyword",
          3: "title.class",
          5: "keyword",
          7: "title.class.inherited"
        }
      },
      // class Car
      {
        match: [
          /class/,
          /\s+/,
          r
        ],
        scope: {
          1: "keyword",
          3: "title.class"
        }
      }
    ]
  }, qt = {
    relevance: 0,
    match: R.either(
      // Hard coded exceptions
      /\bJSON/,
      // Float32Array, OutT
      /\b[A-Z][a-z]+([A-Z][a-z]*|\d)*/,
      // CSSFactory, CSSFactoryT
      /\b[A-Z]{2,}([A-Z][a-z]+|\d)+([A-Z][a-z]*)*/,
      // FPs, FPsT
      /\b[A-Z]{2,}[a-z]+([A-Z][a-z]+|\d)*([A-Z][a-z]*)*/
      // P
      // single letters are not highlighted
      // BLAH
      // this will be flagged as a UPPER_CASE_CONSTANT instead
    ),
    className: "title.class",
    keywords: {
      _: [
        // se we still get relevance credit for JS library classes
        ...$d,
        ...Wd
      ]
    }
  }, Qt = {
    label: "use_strict",
    className: "meta",
    relevance: 10,
    begin: /^\s*['"]use (strict|asm)['"]/
  }, Ge = {
    variants: [
      {
        match: [
          /function/,
          /\s+/,
          r,
          /(?=\s*\()/
        ]
      },
      // anonymous function
      {
        match: [
          /function/,
          /\s*(?=\()/
        ]
      }
    ],
    className: {
      1: "keyword",
      3: "title.function"
    },
    label: "func.def",
    contains: [pt],
    illegal: /%/
  }, ge = {
    relevance: 0,
    match: /\b[A-Z][A-Z_0-9]+\b/,
    className: "variable.constant"
  };
  function ne(x) {
    return R.concat("(?!", x.join("|"), ")");
  }
  const qe = {
    match: R.concat(
      /\b/,
      ne([
        ...Id,
        "super",
        "import",
        "await"
      ].map((x) => `${x}\\s*\\(`)),
      r,
      R.lookahead(/\s*\(/)
    ),
    className: "title.function",
    relevance: 0
  }, oe = {
    begin: R.concat(/\./, R.lookahead(
      R.concat(r, /(?![0-9A-Za-z$_(])/)
    )),
    end: r,
    excludeBegin: !0,
    keywords: "prototype",
    className: "property",
    relevance: 0
  }, me = {
    match: [
      /get|set/,
      /\s+/,
      r,
      /(?=\()/
    ],
    className: {
      1: "keyword",
      3: "title.function"
    },
    contains: [
      {
        // eat to avoid empty params
        begin: /\(\)/
      },
      pt
    ]
  }, p = "(\\([^()]*(\\([^()]*(\\([^()]*\\)[^()]*)*\\)[^()]*)*\\)|" + g.UNDERSCORE_IDENT_RE + ")\\s*=>", U = {
    match: [
      /const|var|let/,
      /\s+/,
      r,
      /\s*/,
      /=\s*/,
      /(async\s*)?/,
      // async is optional
      R.lookahead(p)
    ],
    keywords: "async",
    className: {
      1: "keyword",
      3: "title.function"
    },
    contains: [
      pt
    ]
  };
  return {
    name: "JavaScript",
    aliases: ["js", "jsx", "mjs", "cjs"],
    keywords: V,
    // this will be extended by TypeScript
    exports: { PARAMS_CONTAINS: St, CLASS_REFERENCE: qt },
    illegal: /#(?![$_A-Za-z])/,
    contains: [
      g.SHEBANG({
        label: "shebang",
        binary: "node",
        relevance: 5
      }),
      Qt,
      g.APOS_STRING_MODE,
      g.QUOTE_STRING_MODE,
      ut,
      rt,
      F,
      Mt,
      Ht,
      // Skip numbers when they are part of a variable name
      { match: /\$\d+/ },
      H,
      qt,
      {
        scope: "attr",
        match: r + R.lookahead(":"),
        relevance: 0
      },
      U,
      {
        // "value" container
        begin: "(" + g.RE_STARTERS_RE + "|\\b(case|return|throw)\\b)\\s*",
        keywords: "return throw case",
        relevance: 0,
        contains: [
          Ht,
          g.REGEXP_MODE,
          {
            className: "function",
            // we have to count the parens to make sure we actually have the
            // correct bounding ( ) before the =>.  There could be any number of
            // sub-expressions inside also surrounded by parens.
            begin: p,
            returnBegin: !0,
            end: "\\s*=>",
            contains: [
              {
                className: "params",
                variants: [
                  {
                    begin: g.UNDERSCORE_IDENT_RE,
                    relevance: 0
                  },
                  {
                    className: null,
                    begin: /\(\s*\)/,
                    skip: !0
                  },
                  {
                    begin: /(\s*)\(/,
                    end: /\)/,
                    excludeBegin: !0,
                    excludeEnd: !0,
                    keywords: V,
                    contains: St
                  }
                ]
              }
            ]
          },
          {
            // could be a comma delimited list of params to a function call
            begin: /,/,
            relevance: 0
          },
          {
            match: /\s+/,
            relevance: 0
          },
          {
            // JSX
            variants: [
              { begin: J.begin, end: J.end },
              { match: at },
              {
                begin: I.begin,
                // we carefully check the opening tag to see if it truly
                // is a tag and not a false positive
                "on:begin": I.isTrulyOpeningTag,
                end: I.end
              }
            ],
            subLanguage: "xml",
            contains: [
              {
                begin: I.begin,
                end: I.end,
                skip: !0,
                contains: ["self"]
              }
            ]
          }
        ]
      },
      Ge,
      {
        // prevent this from getting swallowed up by function
        // since they appear "function like"
        beginKeywords: "while if switch catch for"
      },
      {
        // we have to count the parens to make sure we actually have the correct
        // bounding ( ).  There could be any number of sub-expressions inside
        // also surrounded by parens.
        begin: "\\b(?!function)" + g.UNDERSCORE_IDENT_RE + "\\([^()]*(\\([^()]*(\\([^()]*\\)[^()]*)*\\)[^()]*)*\\)\\s*\\{",
        // end parens
        returnBegin: !0,
        label: "func.def",
        contains: [
          pt,
          g.inherit(g.TITLE_MODE, { begin: r, className: "title.function" })
        ]
      },
      // catch ... so it won't trigger the property rule below
      {
        match: /\.\.\./,
        relevance: 0
      },
      oe,
      // hack: prevents detection of keywords in some circumstances
      // .keyword()
      // $keyword = x
      {
        match: "\\$" + r,
        relevance: 0
      },
      {
        match: [/\bconstructor(?=\s*\()/],
        className: { 1: "title.function" },
        contains: [pt]
      },
      qe,
      ge,
      tt,
      me,
      {
        match: /\$[(.]/
        // relevance booster for a pattern common to JS libs: `$(something)` and `$.something`
      }
    ]
  };
}
const Xi = "[A-Za-z$_][0-9A-Za-z$_]*", Fd = [
  "as",
  // for exports
  "in",
  "of",
  "if",
  "for",
  "while",
  "finally",
  "var",
  "new",
  "function",
  "do",
  "return",
  "void",
  "else",
  "break",
  "catch",
  "instanceof",
  "with",
  "throw",
  "case",
  "default",
  "try",
  "switch",
  "continue",
  "typeof",
  "delete",
  "let",
  "yield",
  "const",
  "class",
  // JS handles these with a special rule
  // "get",
  // "set",
  "debugger",
  "async",
  "await",
  "static",
  "import",
  "from",
  "export",
  "extends",
  // It's reached stage 3, which is "recommended for implementation":
  "using"
], Pd = [
  "true",
  "false",
  "null",
  "undefined",
  "NaN",
  "Infinity"
], tg = [
  // Fundamental objects
  "Object",
  "Function",
  "Boolean",
  "Symbol",
  // numbers and dates
  "Math",
  "Date",
  "Number",
  "BigInt",
  // text
  "String",
  "RegExp",
  // Indexed collections
  "Array",
  "Float32Array",
  "Float64Array",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Int32Array",
  "Uint16Array",
  "Uint32Array",
  "BigInt64Array",
  "BigUint64Array",
  // Keyed collections
  "Set",
  "Map",
  "WeakSet",
  "WeakMap",
  // Structured data
  "ArrayBuffer",
  "SharedArrayBuffer",
  "Atomics",
  "DataView",
  "JSON",
  // Control abstraction objects
  "Promise",
  "Generator",
  "GeneratorFunction",
  "AsyncFunction",
  // Reflection
  "Reflect",
  "Proxy",
  // Internationalization
  "Intl",
  // WebAssembly
  "WebAssembly"
], eg = [
  "Error",
  "EvalError",
  "InternalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError"
], lg = [
  "setInterval",
  "setTimeout",
  "clearInterval",
  "clearTimeout",
  "require",
  "exports",
  "eval",
  "isFinite",
  "isNaN",
  "parseFloat",
  "parseInt",
  "decodeURI",
  "decodeURIComponent",
  "encodeURI",
  "encodeURIComponent",
  "escape",
  "unescape"
], ng = [
  "arguments",
  "this",
  "super",
  "console",
  "window",
  "document",
  "localStorage",
  "sessionStorage",
  "module",
  "self",
  "global"
  // Node.js
], ag = [].concat(
  lg,
  tg,
  eg
);
function Oh(g) {
  const R = g.regex, N = (x, { after: et }) => {
    const ft = "</" + x[0].slice(1);
    return x.input.indexOf(ft, et) !== -1;
  }, r = Xi, J = {
    begin: "<>",
    end: "</>"
  }, at = /<[A-Za-z0-9\\._:-]+\s*\/>/, I = {
    begin: /<[A-Za-z0-9\\._:-]+/,
    end: /\/[A-Za-z0-9\\._:-]+>|\/>/,
    /**
     * @param {RegExpMatchArray} match
     * @param {CallbackResponse} response
     */
    isTrulyOpeningTag: (x, et) => {
      const ft = x[0].length + x.index, o = x.input[ft];
      if (
        // HTML should not include another raw `<` inside a tag
        // nested type?
        // `<Array<Array<number>>`, etc.
        o === "<" || // the , gives away that this is not HTML
        // `<T, A extends keyof T, V>`
        o === ","
      ) {
        et.ignoreMatch();
        return;
      }
      o === ">" && (N(x, { after: ft }) || et.ignoreMatch());
      let _;
      const C = x.input.substring(ft);
      if (_ = C.match(/^\s*=/)) {
        et.ignoreMatch();
        return;
      }
      if ((_ = C.match(/^\s+extends\s+/)) && _.index === 0) {
        et.ignoreMatch();
        return;
      }
    }
  }, V = {
    $pattern: Xi,
    keyword: Fd,
    literal: Pd,
    built_in: ag,
    "variable.language": ng
  }, z = "[0-9](_?[0-9])*", E = `\\.(${z})`, j = "0|[1-9](_?[0-9])*|0[0-7]*[89][0-9]*", H = {
    className: "number",
    variants: [
      // DecimalLiteral
      { begin: `(\\b(${j})((${E})|\\.)?|(${E}))[eE][+-]?(${z})\\b` },
      { begin: `\\b(${j})\\b((${E})\\b|\\.)?|(${E})\\b` },
      // DecimalBigIntegerLiteral
      { begin: "\\b(0|[1-9](_?[0-9])*)n\\b" },
      // NonDecimalIntegerLiteral
      { begin: "\\b0[xX][0-9a-fA-F](_?[0-9a-fA-F])*n?\\b" },
      { begin: "\\b0[bB][0-1](_?[0-1])*n?\\b" },
      { begin: "\\b0[oO][0-7](_?[0-7])*n?\\b" },
      // LegacyOctalIntegerLiteral (does not include underscore separators)
      // https://tc39.es/ecma262/#sec-additional-syntax-numeric-literals
      { begin: "\\b0[0-7]+n?\\b" }
    ],
    relevance: 0
  }, Z = {
    className: "subst",
    begin: "\\$\\{",
    end: "\\}",
    keywords: V,
    contains: []
    // defined later
  }, ut = {
    begin: ".?html`",
    end: "",
    starts: {
      end: "`",
      returnEnd: !1,
      contains: [
        g.BACKSLASH_ESCAPE,
        Z
      ],
      subLanguage: "xml"
    }
  }, rt = {
    begin: ".?css`",
    end: "",
    starts: {
      end: "`",
      returnEnd: !1,
      contains: [
        g.BACKSLASH_ESCAPE,
        Z
      ],
      subLanguage: "css"
    }
  }, F = {
    begin: ".?gql`",
    end: "",
    starts: {
      end: "`",
      returnEnd: !1,
      contains: [
        g.BACKSLASH_ESCAPE,
        Z
      ],
      subLanguage: "graphql"
    }
  }, Mt = {
    className: "string",
    begin: "`",
    end: "`",
    contains: [
      g.BACKSLASH_ESCAPE,
      Z
    ]
  }, Ht = {
    className: "comment",
    variants: [
      g.COMMENT(
        /\/\*\*(?!\/)/,
        "\\*/",
        {
          relevance: 0,
          contains: [
            {
              begin: "(?=@[A-Za-z]+)",
              relevance: 0,
              contains: [
                {
                  className: "doctag",
                  begin: "@[A-Za-z]+"
                },
                {
                  className: "type",
                  begin: "\\{",
                  end: "\\}",
                  excludeEnd: !0,
                  excludeBegin: !0,
                  relevance: 0
                },
                {
                  className: "variable",
                  begin: r + "(?=\\s*(-)|$)",
                  endsParent: !0,
                  relevance: 0
                },
                // eat spaces (not newlines) so we can find
                // types or variables
                {
                  begin: /(?=[^\n])\s/,
                  relevance: 0
                }
              ]
            }
          ]
        }
      ),
      g.C_BLOCK_COMMENT_MODE,
      g.C_LINE_COMMENT_MODE
    ]
  }, Nt = [
    g.APOS_STRING_MODE,
    g.QUOTE_STRING_MODE,
    ut,
    rt,
    F,
    Mt,
    // Skip numbers when they are part of a variable name
    { match: /\$\d+/ },
    H
    // This is intentional:
    // See https://github.com/highlightjs/highlight.js/issues/3288
    // hljs.REGEXP_MODE
  ];
  Z.contains = Nt.concat({
    // we need to pair up {} inside our subst to prevent
    // it from ending too early by matching another }
    begin: /\{/,
    end: /\}/,
    keywords: V,
    contains: [
      "self"
    ].concat(Nt)
  });
  const jt = [].concat(Ht, Z.contains), St = jt.concat([
    // eat recursive parens in sub expressions
    {
      begin: /(\s*)\(/,
      end: /\)/,
      keywords: V,
      contains: ["self"].concat(jt)
    }
  ]), pt = {
    className: "params",
    // convert this to negative lookbehind in v12
    begin: /(\s*)\(/,
    // to match the parms with
    end: /\)/,
    excludeBegin: !0,
    excludeEnd: !0,
    keywords: V,
    contains: St
  }, tt = {
    variants: [
      // class Car extends vehicle
      {
        match: [
          /class/,
          /\s+/,
          r,
          /\s+/,
          /extends/,
          /\s+/,
          R.concat(r, "(", R.concat(/\./, r), ")*")
        ],
        scope: {
          1: "keyword",
          3: "title.class",
          5: "keyword",
          7: "title.class.inherited"
        }
      },
      // class Car
      {
        match: [
          /class/,
          /\s+/,
          r
        ],
        scope: {
          1: "keyword",
          3: "title.class"
        }
      }
    ]
  }, qt = {
    relevance: 0,
    match: R.either(
      // Hard coded exceptions
      /\bJSON/,
      // Float32Array, OutT
      /\b[A-Z][a-z]+([A-Z][a-z]*|\d)*/,
      // CSSFactory, CSSFactoryT
      /\b[A-Z]{2,}([A-Z][a-z]+|\d)+([A-Z][a-z]*)*/,
      // FPs, FPsT
      /\b[A-Z]{2,}[a-z]+([A-Z][a-z]+|\d)*([A-Z][a-z]*)*/
      // P
      // single letters are not highlighted
      // BLAH
      // this will be flagged as a UPPER_CASE_CONSTANT instead
    ),
    className: "title.class",
    keywords: {
      _: [
        // se we still get relevance credit for JS library classes
        ...tg,
        ...eg
      ]
    }
  }, Qt = {
    label: "use_strict",
    className: "meta",
    relevance: 10,
    begin: /^\s*['"]use (strict|asm)['"]/
  }, Ge = {
    variants: [
      {
        match: [
          /function/,
          /\s+/,
          r,
          /(?=\s*\()/
        ]
      },
      // anonymous function
      {
        match: [
          /function/,
          /\s*(?=\()/
        ]
      }
    ],
    className: {
      1: "keyword",
      3: "title.function"
    },
    label: "func.def",
    contains: [pt],
    illegal: /%/
  }, ge = {
    relevance: 0,
    match: /\b[A-Z][A-Z_0-9]+\b/,
    className: "variable.constant"
  };
  function ne(x) {
    return R.concat("(?!", x.join("|"), ")");
  }
  const qe = {
    match: R.concat(
      /\b/,
      ne([
        ...lg,
        "super",
        "import",
        "await"
      ].map((x) => `${x}\\s*\\(`)),
      r,
      R.lookahead(/\s*\(/)
    ),
    className: "title.function",
    relevance: 0
  }, oe = {
    begin: R.concat(/\./, R.lookahead(
      R.concat(r, /(?![0-9A-Za-z$_(])/)
    )),
    end: r,
    excludeBegin: !0,
    keywords: "prototype",
    className: "property",
    relevance: 0
  }, me = {
    match: [
      /get|set/,
      /\s+/,
      r,
      /(?=\()/
    ],
    className: {
      1: "keyword",
      3: "title.function"
    },
    contains: [
      {
        // eat to avoid empty params
        begin: /\(\)/
      },
      pt
    ]
  }, p = "(\\([^()]*(\\([^()]*(\\([^()]*\\)[^()]*)*\\)[^()]*)*\\)|" + g.UNDERSCORE_IDENT_RE + ")\\s*=>", U = {
    match: [
      /const|var|let/,
      /\s+/,
      r,
      /\s*/,
      /=\s*/,
      /(async\s*)?/,
      // async is optional
      R.lookahead(p)
    ],
    keywords: "async",
    className: {
      1: "keyword",
      3: "title.function"
    },
    contains: [
      pt
    ]
  };
  return {
    name: "JavaScript",
    aliases: ["js", "jsx", "mjs", "cjs"],
    keywords: V,
    // this will be extended by TypeScript
    exports: { PARAMS_CONTAINS: St, CLASS_REFERENCE: qt },
    illegal: /#(?![$_A-Za-z])/,
    contains: [
      g.SHEBANG({
        label: "shebang",
        binary: "node",
        relevance: 5
      }),
      Qt,
      g.APOS_STRING_MODE,
      g.QUOTE_STRING_MODE,
      ut,
      rt,
      F,
      Mt,
      Ht,
      // Skip numbers when they are part of a variable name
      { match: /\$\d+/ },
      H,
      qt,
      {
        scope: "attr",
        match: r + R.lookahead(":"),
        relevance: 0
      },
      U,
      {
        // "value" container
        begin: "(" + g.RE_STARTERS_RE + "|\\b(case|return|throw)\\b)\\s*",
        keywords: "return throw case",
        relevance: 0,
        contains: [
          Ht,
          g.REGEXP_MODE,
          {
            className: "function",
            // we have to count the parens to make sure we actually have the
            // correct bounding ( ) before the =>.  There could be any number of
            // sub-expressions inside also surrounded by parens.
            begin: p,
            returnBegin: !0,
            end: "\\s*=>",
            contains: [
              {
                className: "params",
                variants: [
                  {
                    begin: g.UNDERSCORE_IDENT_RE,
                    relevance: 0
                  },
                  {
                    className: null,
                    begin: /\(\s*\)/,
                    skip: !0
                  },
                  {
                    begin: /(\s*)\(/,
                    end: /\)/,
                    excludeBegin: !0,
                    excludeEnd: !0,
                    keywords: V,
                    contains: St
                  }
                ]
              }
            ]
          },
          {
            // could be a comma delimited list of params to a function call
            begin: /,/,
            relevance: 0
          },
          {
            match: /\s+/,
            relevance: 0
          },
          {
            // JSX
            variants: [
              { begin: J.begin, end: J.end },
              { match: at },
              {
                begin: I.begin,
                // we carefully check the opening tag to see if it truly
                // is a tag and not a false positive
                "on:begin": I.isTrulyOpeningTag,
                end: I.end
              }
            ],
            subLanguage: "xml",
            contains: [
              {
                begin: I.begin,
                end: I.end,
                skip: !0,
                contains: ["self"]
              }
            ]
          }
        ]
      },
      Ge,
      {
        // prevent this from getting swallowed up by function
        // since they appear "function like"
        beginKeywords: "while if switch catch for"
      },
      {
        // we have to count the parens to make sure we actually have the correct
        // bounding ( ).  There could be any number of sub-expressions inside
        // also surrounded by parens.
        begin: "\\b(?!function)" + g.UNDERSCORE_IDENT_RE + "\\([^()]*(\\([^()]*(\\([^()]*\\)[^()]*)*\\)[^()]*)*\\)\\s*\\{",
        // end parens
        returnBegin: !0,
        label: "func.def",
        contains: [
          pt,
          g.inherit(g.TITLE_MODE, { begin: r, className: "title.function" })
        ]
      },
      // catch ... so it won't trigger the property rule below
      {
        match: /\.\.\./,
        relevance: 0
      },
      oe,
      // hack: prevents detection of keywords in some circumstances
      // .keyword()
      // $keyword = x
      {
        match: "\\$" + r,
        relevance: 0
      },
      {
        match: [/\bconstructor(?=\s*\()/],
        className: { 1: "title.function" },
        contains: [pt]
      },
      qe,
      ge,
      tt,
      me,
      {
        match: /\$[(.]/
        // relevance booster for a pattern common to JS libs: `$(something)` and `$.something`
      }
    ]
  };
}
function Nh(g) {
  const R = g.regex, N = Oh(g), r = Xi, J = [
    "any",
    "void",
    "number",
    "boolean",
    "string",
    "object",
    "never",
    "symbol",
    "bigint",
    "unknown"
  ], at = {
    begin: [
      /namespace/,
      /\s+/,
      g.IDENT_RE
    ],
    beginScope: {
      1: "keyword",
      3: "title.class"
    }
  }, I = {
    beginKeywords: "interface",
    end: /\{/,
    excludeEnd: !0,
    keywords: {
      keyword: "interface extends",
      built_in: J
    },
    contains: [N.exports.CLASS_REFERENCE]
  }, V = {
    className: "meta",
    relevance: 10,
    begin: /^\s*['"]use strict['"]/
  }, z = [
    "type",
    // "namespace",
    "interface",
    "public",
    "private",
    "protected",
    "implements",
    "declare",
    "abstract",
    "readonly",
    "enum",
    "override",
    "satisfies"
  ], E = {
    $pattern: Xi,
    keyword: Fd.concat(z),
    literal: Pd,
    built_in: ag.concat(J),
    "variable.language": ng
  }, j = {
    className: "meta",
    begin: "@" + r
  }, H = (F, Mt, ht) => {
    const Ht = F.contains.findIndex((Nt) => Nt.label === Mt);
    if (Ht === -1)
      throw new Error("can not find mode to replace");
    F.contains.splice(Ht, 1, ht);
  };
  Object.assign(N.keywords, E), N.exports.PARAMS_CONTAINS.push(j);
  const Z = N.contains.find((F) => F.scope === "attr"), ut = Object.assign(
    {},
    Z,
    { match: R.concat(r, R.lookahead(/\s*\?:/)) }
  );
  N.exports.PARAMS_CONTAINS.push([
    N.exports.CLASS_REFERENCE,
    // class reference for highlighting the params types
    Z,
    // highlight the params key
    ut
    // Added for optional property assignment highlighting
  ]), N.contains = N.contains.concat([
    j,
    at,
    I,
    ut
    // Added for optional property assignment highlighting
  ]), H(N, "shebang", g.SHEBANG()), H(N, "use_strict", V);
  const rt = N.contains.find((F) => F.label === "func.def");
  return rt.relevance = 0, Object.assign(N, {
    name: "TypeScript",
    aliases: [
      "ts",
      "tsx",
      "mts",
      "cts"
    ]
  }), N;
}
const Mh = "([-+]?)(\\b0[xX][a-fA-F0-9]+|(\\b\\d+(\\.\\d*)?|\\.\\d+)([eE][-+]?\\d+)?)|NaN|[-+]?Infinity", Rh = {
  scope: "number",
  match: Mh,
  relevance: 0
};
function zh(g) {
  const R = {
    className: "attr",
    begin: /(("(\\.|[^\\"\r\n])*")|('(\\.|[^\\'\r\n])*'))(?=\s*:)/,
    relevance: 1.01
  }, N = {
    match: /[{}[\],:]/,
    className: "punctuation",
    relevance: 0
  }, r = [
    "true",
    "false",
    "null"
  ], J = {
    scope: "literal",
    beginKeywords: r.join(" ")
  };
  return {
    name: "JSON",
    aliases: ["jsonc", "json5"],
    keywords: {
      literal: r
    },
    contains: [
      R,
      N,
      g.APOS_STRING_MODE,
      g.QUOTE_STRING_MODE,
      J,
      Rh,
      g.C_LINE_COMMENT_MODE,
      g.C_BLOCK_COMMENT_MODE
    ],
    illegal: "\\S"
  };
}
function Dh(g) {
  const R = g.regex, N = new RegExp("[\\p{XID_Start}_]\\p{XID_Continue}*", "u"), r = [
    "and",
    "as",
    "assert",
    "async",
    "await",
    "break",
    "case",
    "class",
    "continue",
    "def",
    "del",
    "elif",
    "else",
    "except",
    "finally",
    "for",
    "from",
    "global",
    "if",
    "import",
    "in",
    "is",
    "lambda",
    "lazy",
    "match",
    "nonlocal|10",
    "not",
    "or",
    "pass",
    "raise",
    "return",
    "try",
    "while",
    "with",
    "yield"
  ], V = {
    $pattern: /[A-Za-z]\w+|__\w+__/,
    keyword: r,
    built_in: [
      "__import__",
      "abs",
      "aiter",
      "all",
      "anext",
      "any",
      "ascii",
      "bin",
      "bool",
      "breakpoint",
      "bytearray",
      "bytes",
      "callable",
      "chr",
      "classmethod",
      "compile",
      "complex",
      "delattr",
      "dict",
      "dir",
      "divmod",
      "enumerate",
      "eval",
      "exec",
      "filter",
      "float",
      "format",
      "frozendict",
      "frozenset",
      "getattr",
      "globals",
      "hasattr",
      "hash",
      "help",
      "hex",
      "id",
      "input",
      "int",
      "isinstance",
      "issubclass",
      "iter",
      "len",
      "list",
      "locals",
      "map",
      "max",
      "memoryview",
      "min",
      "next",
      "object",
      "oct",
      "open",
      "ord",
      "pow",
      "print",
      "property",
      "range",
      "repr",
      "reversed",
      "round",
      "sentinel",
      "set",
      "setattr",
      "slice",
      "sorted",
      "staticmethod",
      "str",
      "sum",
      "super",
      "tuple",
      "type",
      "vars",
      "zip"
    ],
    literal: [
      "__debug__",
      "Ellipsis",
      "False",
      "None",
      "NotImplemented",
      "True"
    ],
    type: [
      "Any",
      "Callable",
      "Coroutine",
      "Dict",
      "List",
      "Literal",
      "Generic",
      "Optional",
      "Sequence",
      "Set",
      "Tuple",
      "Type",
      "Union"
    ]
  }, z = {
    className: "meta",
    begin: /^(>>>|\.\.\.) /
  }, E = {
    className: "subst",
    begin: /\{/,
    end: /\}/,
    keywords: V,
    illegal: /#/
  }, j = {
    begin: /\{\{/,
    relevance: 0
  }, H = {
    className: "string",
    contains: [g.BACKSLASH_ESCAPE],
    variants: [
      {
        begin: /([uU]|[bB]|[rR]|[bB][rR]|[rR][bB])?'''/,
        end: /'''/,
        contains: [
          g.BACKSLASH_ESCAPE,
          z
        ],
        relevance: 10
      },
      {
        begin: /([uU]|[bB]|[rR]|[bB][rR]|[rR][bB])?"""/,
        end: /"""/,
        contains: [
          g.BACKSLASH_ESCAPE,
          z
        ],
        relevance: 10
      },
      {
        begin: /([fFtT][rR]|[rR][fFtT]|[fFtT])'''/,
        end: /'''/,
        contains: [
          g.BACKSLASH_ESCAPE,
          z,
          j,
          E
        ]
      },
      {
        begin: /([fFtT][rR]|[rR][fFtT]|[fFtT])"""/,
        end: /"""/,
        contains: [
          g.BACKSLASH_ESCAPE,
          z,
          j,
          E
        ]
      },
      {
        begin: /([uU]|[rR])'/,
        end: /'/,
        relevance: 10
      },
      {
        begin: /([uU]|[rR])"/,
        end: /"/,
        relevance: 10
      },
      {
        begin: /([bB]|[bB][rR]|[rR][bB])'/,
        end: /'/
      },
      {
        begin: /([bB]|[bB][rR]|[rR][bB])"/,
        end: /"/
      },
      {
        begin: /([fFtT][rR]|[rR][fFtT]|[fFtT])'/,
        end: /'/,
        contains: [
          g.BACKSLASH_ESCAPE,
          j,
          E
        ]
      },
      {
        begin: /([fFtT][rR]|[rR][fFtT]|[fFtT])"/,
        end: /"/,
        contains: [
          g.BACKSLASH_ESCAPE,
          j,
          E
        ]
      },
      g.APOS_STRING_MODE,
      g.QUOTE_STRING_MODE
    ]
  }, Z = "[0-9](_?[0-9])*", ut = `(\\b(${Z}))?\\.(${Z})|\\b(${Z})\\.`, rt = `\\b|${r.join("|")}`, F = {
    className: "number",
    relevance: 0,
    variants: [
      // exponentfloat, pointfloat
      // https://docs.python.org/3.9/reference/lexical_analysis.html#floating-point-literals
      // optionally imaginary
      // https://docs.python.org/3.9/reference/lexical_analysis.html#imaginary-literals
      // Note: no leading \b because floats can start with a decimal point
      // and we don't want to mishandle e.g. `fn(.5)`,
      // no trailing \b for pointfloat because it can end with a decimal point
      // and we don't want to mishandle e.g. `0..hex()`; this should be safe
      // because both MUST contain a decimal point and so cannot be confused with
      // the interior part of an identifier
      {
        begin: `(\\b(${Z})|(${ut}))[eE][+-]?(${Z})[jJ]?(?=${rt})`
      },
      {
        begin: `(${ut})[jJ]?`
      },
      // decinteger, bininteger, octinteger, hexinteger
      // https://docs.python.org/3.9/reference/lexical_analysis.html#integer-literals
      // optionally "long" in Python 2
      // https://docs.python.org/2.7/reference/lexical_analysis.html#integer-and-long-integer-literals
      // decinteger is optionally imaginary
      // https://docs.python.org/3.9/reference/lexical_analysis.html#imaginary-literals
      {
        begin: `\\b([1-9](_?[0-9])*|0+(_?0)*)[lLjJ]?(?=${rt})`
      },
      {
        begin: `\\b0[bB](_?[01])+[lL]?(?=${rt})`
      },
      {
        begin: `\\b0[oO](_?[0-7])+[lL]?(?=${rt})`
      },
      {
        begin: `\\b0[xX](_?[0-9a-fA-F])+[lL]?(?=${rt})`
      },
      // imagnumber (digitpart-based)
      // https://docs.python.org/3.9/reference/lexical_analysis.html#imaginary-literals
      {
        begin: `\\b(${Z})[jJ](?=${rt})`
      }
    ]
  }, Mt = {
    className: "comment",
    begin: R.lookahead(/# type:/),
    end: /$/,
    keywords: V,
    contains: [
      {
        // prevent keywords from coloring `type`
        begin: /# type:/
      },
      // comment within a datatype comment includes no keywords
      {
        begin: /#/,
        end: /\b\B/,
        endsWithParent: !0
      }
    ]
  }, ht = {
    className: "params",
    variants: [
      // Exclude params in functions without params
      {
        className: "",
        begin: /\(\s*\)/,
        skip: !0
      },
      {
        begin: /\(/,
        end: /\)/,
        excludeBegin: !0,
        excludeEnd: !0,
        keywords: V,
        contains: [
          "self",
          z,
          F,
          H,
          g.HASH_COMMENT_MODE
        ]
      }
    ]
  };
  return E.contains = [
    H,
    F,
    z
  ], {
    name: "Python",
    aliases: [
      "py",
      "gyp",
      "ipython"
    ],
    unicodeRegex: !0,
    keywords: V,
    illegal: /(<\/|\?)|=>/,
    contains: [
      z,
      F,
      {
        // very common convention
        scope: "variable.language",
        match: /\bself\b/
      },
      {
        // eat "if" prior to string so that it won't accidentally be
        // labeled as an f-string
        beginKeywords: "if",
        relevance: 0
      },
      { match: /\bor\b/, scope: "keyword" },
      H,
      Mt,
      g.HASH_COMMENT_MODE,
      {
        match: [
          /\bdef/,
          /\s+/,
          N
        ],
        scope: {
          1: "keyword",
          3: "title.function"
        },
        contains: [ht]
      },
      {
        variants: [
          {
            match: [
              /\bclass/,
              /\s+/,
              N,
              /\s*/,
              /\(\s*/,
              N,
              /\s*\)/
            ]
          },
          {
            match: [
              /\bclass/,
              /\s+/,
              N
            ]
          }
        ],
        scope: {
          1: "keyword",
          3: "title.class",
          6: "title.class.inherited"
        }
      },
      {
        className: "meta",
        begin: /^[\t ]*@/,
        end: /(?=#)|$/,
        contains: [
          F,
          ht,
          H
        ]
      }
    ]
  };
}
function Ch(g) {
  const R = g.regex, N = {}, r = {
    begin: /\$\{/,
    end: /\}/,
    contains: [
      "self",
      {
        begin: /:-/,
        contains: [N]
      }
      // default values
    ]
  };
  Object.assign(N, {
    className: "variable",
    variants: [
      { begin: R.concat(
        /\$[\w\d#@][\w\d_]*/,
        // negative look-ahead tries to avoid matching patterns that are not
        // Perl at all like $ident$, @ident@, etc.
        "(?![\\w\\d])(?![$])"
      ) },
      r
    ]
  });
  const J = {
    className: "subst",
    begin: /\$\(/,
    end: /\)/,
    contains: [g.BACKSLASH_ESCAPE]
  }, at = g.inherit(
    g.COMMENT(),
    {
      match: [
        /(^|\s)/,
        /#.*$/
      ],
      scope: {
        2: "comment"
      }
    }
  ), I = {
    begin: /<<-?\s*(?=\w+)/,
    starts: { contains: [
      g.END_SAME_AS_BEGIN({
        begin: /(\w+)/,
        end: /(\w+)/,
        className: "string"
      })
    ] }
  }, V = {
    className: "string",
    begin: /"/,
    end: /"/,
    contains: [
      g.BACKSLASH_ESCAPE,
      N,
      J
    ]
  };
  J.contains.push(V);
  const z = {
    match: /\\"/
  }, E = {
    className: "string",
    begin: /'/,
    end: /'/
  }, j = {
    match: /\\'/
  }, H = {
    begin: /\$?\(\(/,
    end: /\)\)/,
    contains: [
      {
        begin: /\d+#[0-9a-f]+/,
        className: "number"
      },
      g.NUMBER_MODE,
      N
    ]
  }, Z = [
    "fish",
    "bash",
    "zsh",
    "sh",
    "csh",
    "ksh",
    "tcsh",
    "dash",
    "scsh"
  ], ut = g.SHEBANG({
    binary: `(${Z.join("|")})`,
    relevance: 10
  }), rt = {
    className: "function",
    begin: /\w[\w\d_]*\s*\(\s*\)\s*\{/,
    returnBegin: !0,
    contains: [g.inherit(g.TITLE_MODE, { begin: /\w[\w\d_]*/ })],
    relevance: 0
  }, F = [
    "if",
    "then",
    "else",
    "elif",
    "fi",
    "time",
    "for",
    "while",
    "until",
    "in",
    "do",
    "done",
    "case",
    "esac",
    "coproc",
    "function",
    "select"
  ], Mt = [
    "true",
    "false"
  ], ht = { match: /(\/[a-z._-]+)+/ }, Ht = [
    "break",
    "cd",
    "continue",
    "eval",
    "exec",
    "exit",
    "export",
    "getopts",
    "hash",
    "pwd",
    "readonly",
    "return",
    "shift",
    "test",
    "times",
    "trap",
    "umask",
    "unset"
  ], Nt = [
    "alias",
    "bind",
    "builtin",
    "caller",
    "command",
    "declare",
    "echo",
    "enable",
    "help",
    "let",
    "local",
    "logout",
    "mapfile",
    "printf",
    "read",
    "readarray",
    "source",
    "sudo",
    "type",
    "typeset",
    "ulimit",
    "unalias"
  ], jt = [
    "autoload",
    "bg",
    "bindkey",
    "bye",
    "cap",
    "chdir",
    "clone",
    "comparguments",
    "compcall",
    "compctl",
    "compdescribe",
    "compfiles",
    "compgroups",
    "compquote",
    "comptags",
    "comptry",
    "compvalues",
    "dirs",
    "disable",
    "disown",
    "echotc",
    "echoti",
    "emulate",
    "fc",
    "fg",
    "float",
    "functions",
    "getcap",
    "getln",
    "history",
    "integer",
    "jobs",
    "kill",
    "limit",
    "log",
    "noglob",
    "popd",
    "print",
    "pushd",
    "pushln",
    "rehash",
    "sched",
    "setcap",
    "setopt",
    "stat",
    "suspend",
    "ttyctl",
    "unfunction",
    "unhash",
    "unlimit",
    "unsetopt",
    "vared",
    "wait",
    "whence",
    "where",
    "which",
    "zcompile",
    "zformat",
    "zftp",
    "zle",
    "zmodload",
    "zparseopts",
    "zprof",
    "zpty",
    "zregexparse",
    "zsocket",
    "zstyle",
    "ztcp"
  ], St = [
    "chcon",
    "chgrp",
    "chown",
    "chmod",
    "cp",
    "dd",
    "df",
    "dir",
    "dircolors",
    "ln",
    "ls",
    "mkdir",
    "mkfifo",
    "mknod",
    "mktemp",
    "mv",
    "realpath",
    "rm",
    "rmdir",
    "shred",
    "sync",
    "touch",
    "truncate",
    "vdir",
    "b2sum",
    "base32",
    "base64",
    "cat",
    "cksum",
    "comm",
    "csplit",
    "cut",
    "expand",
    "fmt",
    "fold",
    "head",
    "join",
    "md5sum",
    "nl",
    "numfmt",
    "od",
    "paste",
    "ptx",
    "pr",
    "sha1sum",
    "sha224sum",
    "sha256sum",
    "sha384sum",
    "sha512sum",
    "shuf",
    "sort",
    "split",
    "sum",
    "tac",
    "tail",
    "tr",
    "tsort",
    "unexpand",
    "uniq",
    "wc",
    "arch",
    "basename",
    "chroot",
    "date",
    "dirname",
    "du",
    "echo",
    "env",
    "expr",
    "factor",
    // "false", // keyword literal already
    "groups",
    "hostid",
    "id",
    "link",
    "logname",
    "nice",
    "nohup",
    "nproc",
    "pathchk",
    "pinky",
    "printenv",
    "printf",
    "pwd",
    "readlink",
    "runcon",
    "seq",
    "sleep",
    "stat",
    "stdbuf",
    "stty",
    "tee",
    "test",
    "timeout",
    // "true", // keyword literal already
    "tty",
    "uname",
    "unlink",
    "uptime",
    "users",
    "who",
    "whoami",
    "yes"
  ];
  return {
    name: "Bash",
    aliases: [
      "sh",
      "zsh"
    ],
    keywords: {
      $pattern: /\b[a-z][a-z0-9._-]+\b/,
      keyword: F,
      literal: Mt,
      built_in: [
        ...Ht,
        ...Nt,
        // Shell modifiers
        "set",
        "shopt",
        ...jt,
        ...St
      ]
    },
    contains: [
      ut,
      // to catch known shells and boost relevancy
      g.SHEBANG(),
      // to catch unknown shells but still highlight the shebang
      rt,
      H,
      at,
      I,
      ht,
      V,
      z,
      E,
      j,
      N
    ]
  };
}
const Uh = (g) => ({
  IMPORTANT: {
    scope: "meta",
    begin: "!important"
  },
  BLOCK_COMMENT: g.C_BLOCK_COMMENT_MODE,
  HEXCOLOR: {
    scope: "number",
    begin: /#(([0-9a-fA-F]{3,4})|(([0-9a-fA-F]{2}){3,4}))\b/
  },
  UNICODE_RANGE: {
    scope: "number",
    begin: /\b[Uu]\+[0-9A-Fa-f][0-9A-Fa-f?]{0,5}(-[0-9A-Fa-f][0-9A-Fa-f]{0,5})?/
  },
  FUNCTION_DISPATCH: {
    className: "built_in",
    begin: /[\w-]+(?=\()/
  },
  ATTRIBUTE_SELECTOR_MODE: {
    scope: "selector-attr",
    begin: /\[/,
    end: /\]/,
    illegal: "$",
    contains: [
      g.APOS_STRING_MODE,
      g.QUOTE_STRING_MODE
    ]
  },
  CSS_NUMBER_MODE: {
    scope: "number",
    begin: g.NUMBER_RE + "(%|em|ex|ch|rem|vw|vh|vmin|vmax|cm|mm|in|pt|pc|px|deg|grad|rad|turn|s|ms|Hz|kHz|dpi|dpcm|dppx)?",
    relevance: 0
  },
  CSS_VARIABLE: {
    className: "attr",
    begin: /--[A-Za-z_][A-Za-z0-9_-]*/
  }
}), xh = [
  "a",
  "abbr",
  "address",
  "article",
  "aside",
  "audio",
  "b",
  "blockquote",
  "body",
  "button",
  "canvas",
  "caption",
  "cite",
  "code",
  "dd",
  "del",
  "details",
  "dfn",
  "div",
  "dl",
  "dt",
  "em",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "html",
  "i",
  "iframe",
  "img",
  "input",
  "ins",
  "kbd",
  "label",
  "legend",
  "li",
  "main",
  "mark",
  "menu",
  "nav",
  "object",
  "ol",
  "optgroup",
  "option",
  "p",
  "picture",
  "q",
  "quote",
  "samp",
  "section",
  "select",
  "source",
  "span",
  "strong",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "textarea",
  "tfoot",
  "th",
  "thead",
  "time",
  "tr",
  "ul",
  "var",
  "video"
], Bh = [
  "defs",
  "g",
  "marker",
  "mask",
  "pattern",
  "svg",
  "switch",
  "symbol",
  "feBlend",
  "feColorMatrix",
  "feComponentTransfer",
  "feComposite",
  "feConvolveMatrix",
  "feDiffuseLighting",
  "feDisplacementMap",
  "feFlood",
  "feGaussianBlur",
  "feImage",
  "feMerge",
  "feMorphology",
  "feOffset",
  "feSpecularLighting",
  "feTile",
  "feTurbulence",
  "linearGradient",
  "radialGradient",
  "stop",
  "circle",
  "ellipse",
  "image",
  "line",
  "path",
  "polygon",
  "polyline",
  "rect",
  "text",
  "use",
  "textPath",
  "tspan",
  "foreignObject",
  "clipPath"
], Hh = [
  ...xh,
  ...Bh
], Lh = [
  "any-hover",
  "any-pointer",
  "aspect-ratio",
  "color",
  "color-gamut",
  "color-index",
  "device-aspect-ratio",
  "device-height",
  "device-width",
  "display-mode",
  "forced-colors",
  "grid",
  "height",
  "hover",
  "inverted-colors",
  "monochrome",
  "orientation",
  "overflow-block",
  "overflow-inline",
  "pointer",
  "prefers-color-scheme",
  "prefers-contrast",
  "prefers-reduced-motion",
  "prefers-reduced-transparency",
  "resolution",
  "scan",
  "scripting",
  "update",
  "width",
  // TODO: find a better solution?
  "min-width",
  "max-width",
  "min-height",
  "max-height"
].sort().reverse(), Gh = [
  "active",
  "any-link",
  "blank",
  "checked",
  "current",
  "default",
  "defined",
  "dir",
  // dir()
  "disabled",
  "drop",
  "empty",
  "enabled",
  "first",
  "first-child",
  "first-of-type",
  "fullscreen",
  "future",
  "focus",
  "focus-visible",
  "focus-within",
  "has",
  // has()
  "host",
  // host or host()
  "host-context",
  // host-context()
  "hover",
  "indeterminate",
  "in-range",
  "invalid",
  "is",
  // is()
  "lang",
  // lang()
  "last-child",
  "last-of-type",
  "left",
  "link",
  "local-link",
  "not",
  // not()
  "nth-child",
  // nth-child()
  "nth-col",
  // nth-col()
  "nth-last-child",
  // nth-last-child()
  "nth-last-col",
  // nth-last-col()
  "nth-last-of-type",
  //nth-last-of-type()
  "nth-of-type",
  //nth-of-type()
  "only-child",
  "only-of-type",
  "optional",
  "out-of-range",
  "past",
  "placeholder-shown",
  "read-only",
  "read-write",
  "required",
  "right",
  "root",
  "scope",
  "target",
  "target-within",
  "user-invalid",
  "valid",
  "visited",
  "where"
  // where()
].sort().reverse(), qh = [
  "after",
  "backdrop",
  "before",
  "cue",
  "cue-region",
  "first-letter",
  "first-line",
  "grammar-error",
  "marker",
  "part",
  "placeholder",
  "selection",
  "slotted",
  "spelling-error"
].sort().reverse(), Yh = [
  "accent-color",
  "align-content",
  "align-items",
  "align-self",
  "alignment-baseline",
  "all",
  "anchor-name",
  "animation",
  "animation-composition",
  "animation-delay",
  "animation-direction",
  "animation-duration",
  "animation-fill-mode",
  "animation-iteration-count",
  "animation-name",
  "animation-play-state",
  "animation-range",
  "animation-range-end",
  "animation-range-start",
  "animation-timeline",
  "animation-timing-function",
  "appearance",
  "aspect-ratio",
  "backdrop-filter",
  "backface-visibility",
  "background",
  "background-attachment",
  "background-blend-mode",
  "background-clip",
  "background-color",
  "background-image",
  "background-origin",
  "background-position",
  "background-position-x",
  "background-position-y",
  "background-repeat",
  "background-size",
  "baseline-shift",
  "block-size",
  "border",
  "border-block",
  "border-block-color",
  "border-block-end",
  "border-block-end-color",
  "border-block-end-style",
  "border-block-end-width",
  "border-block-start",
  "border-block-start-color",
  "border-block-start-style",
  "border-block-start-width",
  "border-block-style",
  "border-block-width",
  "border-bottom",
  "border-bottom-color",
  "border-bottom-left-radius",
  "border-bottom-right-radius",
  "border-bottom-style",
  "border-bottom-width",
  "border-collapse",
  "border-color",
  "border-end-end-radius",
  "border-end-start-radius",
  "border-image",
  "border-image-outset",
  "border-image-repeat",
  "border-image-slice",
  "border-image-source",
  "border-image-width",
  "border-inline",
  "border-inline-color",
  "border-inline-end",
  "border-inline-end-color",
  "border-inline-end-style",
  "border-inline-end-width",
  "border-inline-start",
  "border-inline-start-color",
  "border-inline-start-style",
  "border-inline-start-width",
  "border-inline-style",
  "border-inline-width",
  "border-left",
  "border-left-color",
  "border-left-style",
  "border-left-width",
  "border-radius",
  "border-right",
  "border-right-color",
  "border-right-style",
  "border-right-width",
  "border-spacing",
  "border-start-end-radius",
  "border-start-start-radius",
  "border-style",
  "border-top",
  "border-top-color",
  "border-top-left-radius",
  "border-top-right-radius",
  "border-top-style",
  "border-top-width",
  "border-width",
  "bottom",
  "box-align",
  "box-decoration-break",
  "box-direction",
  "box-flex",
  "box-flex-group",
  "box-lines",
  "box-ordinal-group",
  "box-orient",
  "box-pack",
  "box-shadow",
  "box-sizing",
  "break-after",
  "break-before",
  "break-inside",
  "caption-side",
  "caret-color",
  "clear",
  "clip",
  "clip-path",
  "clip-rule",
  "color",
  "color-interpolation",
  "color-interpolation-filters",
  "color-profile",
  "color-rendering",
  "color-scheme",
  "column-count",
  "column-fill",
  "column-gap",
  "column-rule",
  "column-rule-color",
  "column-rule-style",
  "column-rule-width",
  "column-span",
  "column-width",
  "columns",
  "contain",
  "contain-intrinsic-block-size",
  "contain-intrinsic-height",
  "contain-intrinsic-inline-size",
  "contain-intrinsic-size",
  "contain-intrinsic-width",
  "container",
  "container-name",
  "container-type",
  "content",
  "content-visibility",
  "corner-bottom-left-shape",
  "corner-bottom-right-shape",
  "corner-shape",
  "corner-top-left-shape",
  "corner-top-right-shape",
  "counter-increment",
  "counter-reset",
  "counter-set",
  "cue",
  "cue-after",
  "cue-before",
  "cursor",
  "cx",
  "cy",
  "direction",
  "display",
  "dominant-baseline",
  "empty-cells",
  "enable-background",
  "field-sizing",
  "fill",
  "fill-opacity",
  "fill-rule",
  "filter",
  "flex",
  "flex-basis",
  "flex-direction",
  "flex-flow",
  "flex-grow",
  "flex-shrink",
  "flex-wrap",
  "float",
  "flood-color",
  "flood-opacity",
  "flow",
  "font",
  "font-display",
  "font-family",
  "font-feature-settings",
  "font-kerning",
  "font-language-override",
  "font-optical-sizing",
  "font-palette",
  "font-size",
  "font-size-adjust",
  "font-smooth",
  "font-smoothing",
  "font-stretch",
  "font-style",
  "font-synthesis",
  "font-synthesis-position",
  "font-synthesis-small-caps",
  "font-synthesis-style",
  "font-synthesis-weight",
  "font-variant",
  "font-variant-alternates",
  "font-variant-caps",
  "font-variant-east-asian",
  "font-variant-emoji",
  "font-variant-ligatures",
  "font-variant-numeric",
  "font-variant-position",
  "font-variation-settings",
  "font-weight",
  "forced-color-adjust",
  "gap",
  "glyph-orientation-horizontal",
  "glyph-orientation-vertical",
  "grid",
  "grid-area",
  "grid-auto-columns",
  "grid-auto-flow",
  "grid-auto-rows",
  "grid-column",
  "grid-column-end",
  "grid-column-start",
  "grid-gap",
  "grid-row",
  "grid-row-end",
  "grid-row-start",
  "grid-template",
  "grid-template-areas",
  "grid-template-columns",
  "grid-template-rows",
  "hanging-punctuation",
  "height",
  "hyphenate-character",
  "hyphenate-limit-chars",
  "hyphens",
  "icon",
  "image-orientation",
  "image-rendering",
  "image-resolution",
  "ime-mode",
  "initial-letter",
  "initial-letter-align",
  "inline-size",
  "inset",
  "inset-area",
  "inset-block",
  "inset-block-end",
  "inset-block-start",
  "inset-inline",
  "inset-inline-end",
  "inset-inline-start",
  "isolation",
  "justify-content",
  "justify-items",
  "justify-self",
  "kerning",
  "left",
  "letter-spacing",
  "lighting-color",
  "line-break",
  "line-height",
  "line-height-step",
  "list-style",
  "list-style-image",
  "list-style-position",
  "list-style-type",
  "margin",
  "margin-block",
  "margin-block-end",
  "margin-block-start",
  "margin-bottom",
  "margin-inline",
  "margin-inline-end",
  "margin-inline-start",
  "margin-left",
  "margin-right",
  "margin-top",
  "margin-trim",
  "marker",
  "marker-end",
  "marker-mid",
  "marker-start",
  "marks",
  "mask",
  "mask-border",
  "mask-border-mode",
  "mask-border-outset",
  "mask-border-repeat",
  "mask-border-slice",
  "mask-border-source",
  "mask-border-width",
  "mask-clip",
  "mask-composite",
  "mask-image",
  "mask-mode",
  "mask-origin",
  "mask-position",
  "mask-repeat",
  "mask-size",
  "mask-type",
  "masonry-auto-flow",
  "math-depth",
  "math-shift",
  "math-style",
  "max-block-size",
  "max-height",
  "max-inline-size",
  "max-width",
  "min-block-size",
  "min-height",
  "min-inline-size",
  "min-width",
  "mix-blend-mode",
  "nav-down",
  "nav-index",
  "nav-left",
  "nav-right",
  "nav-up",
  "none",
  "normal",
  "object-fit",
  "object-position",
  "offset",
  "offset-anchor",
  "offset-distance",
  "offset-path",
  "offset-position",
  "offset-rotate",
  "opacity",
  "order",
  "orphans",
  "outline",
  "outline-color",
  "outline-offset",
  "outline-style",
  "outline-width",
  "overflow",
  "overflow-anchor",
  "overflow-block",
  "overflow-clip-margin",
  "overflow-inline",
  "overflow-wrap",
  "overflow-x",
  "overflow-y",
  "overlay",
  "overscroll-behavior",
  "overscroll-behavior-block",
  "overscroll-behavior-inline",
  "overscroll-behavior-x",
  "overscroll-behavior-y",
  "padding",
  "padding-block",
  "padding-block-end",
  "padding-block-start",
  "padding-bottom",
  "padding-inline",
  "padding-inline-end",
  "padding-inline-start",
  "padding-left",
  "padding-right",
  "padding-top",
  "page",
  "page-break-after",
  "page-break-before",
  "page-break-inside",
  "paint-order",
  "pause",
  "pause-after",
  "pause-before",
  "perspective",
  "perspective-origin",
  "place-content",
  "place-items",
  "place-self",
  "pointer-events",
  "position",
  "position-anchor",
  "position-visibility",
  "print-color-adjust",
  "quotes",
  "r",
  "resize",
  "rest",
  "rest-after",
  "rest-before",
  "right",
  "rotate",
  "row-gap",
  "ruby-align",
  "ruby-position",
  "scale",
  "scroll-behavior",
  "scroll-margin",
  "scroll-margin-block",
  "scroll-margin-block-end",
  "scroll-margin-block-start",
  "scroll-margin-bottom",
  "scroll-margin-inline",
  "scroll-margin-inline-end",
  "scroll-margin-inline-start",
  "scroll-margin-left",
  "scroll-margin-right",
  "scroll-margin-top",
  "scroll-padding",
  "scroll-padding-block",
  "scroll-padding-block-end",
  "scroll-padding-block-start",
  "scroll-padding-bottom",
  "scroll-padding-inline",
  "scroll-padding-inline-end",
  "scroll-padding-inline-start",
  "scroll-padding-left",
  "scroll-padding-right",
  "scroll-padding-top",
  "scroll-snap-align",
  "scroll-snap-stop",
  "scroll-snap-type",
  "scroll-timeline",
  "scroll-timeline-axis",
  "scroll-timeline-name",
  "scrollbar-color",
  "scrollbar-gutter",
  "scrollbar-width",
  "shape-image-threshold",
  "shape-margin",
  "shape-outside",
  "shape-rendering",
  "speak",
  "speak-as",
  "src",
  // @font-face
  "stop-color",
  "stop-opacity",
  "stroke",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-opacity",
  "stroke-width",
  "tab-size",
  "table-layout",
  "text-align",
  "text-align-all",
  "text-align-last",
  "text-anchor",
  "text-combine-upright",
  "text-decoration",
  "text-decoration-color",
  "text-decoration-line",
  "text-decoration-skip",
  "text-decoration-skip-ink",
  "text-decoration-style",
  "text-decoration-thickness",
  "text-emphasis",
  "text-emphasis-color",
  "text-emphasis-position",
  "text-emphasis-style",
  "text-indent",
  "text-justify",
  "text-orientation",
  "text-overflow",
  "text-rendering",
  "text-shadow",
  "text-size-adjust",
  "text-transform",
  "text-underline-offset",
  "text-underline-position",
  "text-wrap",
  "text-wrap-mode",
  "text-wrap-style",
  "timeline-scope",
  "top",
  "touch-action",
  "transform",
  "transform-box",
  "transform-origin",
  "transform-style",
  "transition",
  "transition-behavior",
  "transition-delay",
  "transition-duration",
  "transition-property",
  "transition-timing-function",
  "translate",
  "unicode-bidi",
  "unicode-range",
  "user-modify",
  "user-select",
  "vector-effect",
  "vertical-align",
  "view-timeline",
  "view-timeline-axis",
  "view-timeline-inset",
  "view-timeline-name",
  "view-transition-name",
  "visibility",
  "voice-balance",
  "voice-duration",
  "voice-family",
  "voice-pitch",
  "voice-range",
  "voice-rate",
  "voice-stress",
  "voice-volume",
  "white-space",
  "white-space-collapse",
  "widows",
  "width",
  "will-change",
  "word-break",
  "word-spacing",
  "word-wrap",
  "writing-mode",
  "x",
  "y",
  "z-index",
  "zoom"
].sort().reverse();
function wh(g) {
  const R = g.regex, N = Uh(g), r = { begin: /-(webkit|moz|ms|o)-(?=[a-z])/ }, J = "and or not only", at = /@-?\w[\w]*(-\w+)*/, I = "[a-zA-Z-][a-zA-Z0-9_-]*", V = [
    g.APOS_STRING_MODE,
    g.QUOTE_STRING_MODE
  ];
  return {
    name: "CSS",
    case_insensitive: !0,
    illegal: /[=|'\$]/,
    keywords: { keyframePosition: "from to" },
    classNameAliases: {
      // for visual continuity with `tag {}` and because we
      // don't have a great class for this?
      keyframePosition: "selector-tag"
    },
    contains: [
      N.BLOCK_COMMENT,
      r,
      // to recognize keyframe 40% etc which are outside the scope of our
      // attribute value mode
      N.CSS_NUMBER_MODE,
      {
        className: "selector-id",
        begin: /#[A-Za-z0-9_-]+/,
        relevance: 0
      },
      {
        className: "selector-class",
        begin: "\\." + I,
        relevance: 0
      },
      N.ATTRIBUTE_SELECTOR_MODE,
      {
        className: "selector-pseudo",
        variants: [
          { begin: ":(" + Gh.join("|") + ")" },
          { begin: ":(:)?(" + qh.join("|") + ")" }
        ]
      },
      // we may actually need this (12/2020)
      // { // pseudo-selector params
      //   begin: /\(/,
      //   end: /\)/,
      //   contains: [ hljs.CSS_NUMBER_MODE ]
      // },
      N.CSS_VARIABLE,
      {
        className: "attribute",
        begin: "\\b(" + Yh.join("|") + ")\\b"
      },
      // attribute values
      {
        begin: /:/,
        end: /[;}{]/,
        contains: [
          N.BLOCK_COMMENT,
          N.HEXCOLOR,
          N.IMPORTANT,
          N.CSS_NUMBER_MODE,
          N.UNICODE_RANGE,
          ...V,
          // needed to highlight these as strings and to avoid issues with
          // illegal characters that might be inside urls that would trigger the
          // languages illegal stack
          {
            begin: /(url|data-uri)\(/,
            end: /\)/,
            relevance: 0,
            // from keywords
            keywords: { built_in: "url data-uri" },
            contains: [
              ...V,
              {
                className: "string",
                // any character other than `)` as in `url()` will be the start
                // of a string, which ends with `)` (from the parent mode)
                begin: /[^)]/,
                endsWithParent: !0,
                excludeEnd: !0
              }
            ]
          },
          N.FUNCTION_DISPATCH
        ]
      },
      {
        begin: R.lookahead(/@/),
        end: "[{;]",
        relevance: 0,
        illegal: /:/,
        // break on Less variables @var: ...
        contains: [
          {
            className: "keyword",
            begin: at
          },
          {
            begin: /\s/,
            endsWithParent: !0,
            excludeEnd: !0,
            relevance: 0,
            keywords: {
              $pattern: /[a-z-]+/,
              keyword: J,
              attribute: Lh.join(" ")
            },
            contains: [
              {
                begin: /[a-z-]+(?=:)/,
                className: "attribute"
              },
              ...V,
              N.CSS_NUMBER_MODE
            ]
          }
        ]
      },
      {
        className: "selector-tag",
        begin: "\\b(" + Hh.join("|") + ")\\b"
      }
    ]
  };
}
function Xh(g) {
  const R = g.regex, N = R.concat(/[\p{L}_]/u, R.optional(/[\p{L}0-9_.-]*:/u), /[\p{L}0-9_.-]*/u), r = /[\p{L}0-9._:-]+/u, J = {
    className: "symbol",
    begin: /&[a-z]+;|&#[0-9]+;|&#x[a-f0-9]+;/
  }, at = {
    begin: /\s/,
    contains: [
      {
        className: "keyword",
        begin: /#?[a-z_][a-z1-9_-]+/,
        illegal: /\n/
      }
    ]
  }, I = g.inherit(at, {
    begin: /\(/,
    end: /\)/
  }), V = g.inherit(g.APOS_STRING_MODE, { className: "string" }), z = g.inherit(g.QUOTE_STRING_MODE, { className: "string" }), E = {
    endsWithParent: !0,
    illegal: /</,
    relevance: 0,
    contains: [
      {
        className: "attr",
        begin: r,
        relevance: 0
      },
      {
        begin: /=\s*/,
        relevance: 0,
        contains: [
          {
            className: "string",
            endsParent: !0,
            variants: [
              {
                begin: /"/,
                end: /"/,
                contains: [J]
              },
              {
                begin: /'/,
                end: /'/,
                contains: [J]
              },
              { begin: /[^\s"'=<>`]+/ }
            ]
          }
        ]
      }
    ]
  };
  return {
    name: "HTML, XML",
    aliases: [
      "html",
      "xhtml",
      "rss",
      "atom",
      "xjb",
      "xsd",
      "xsl",
      "plist",
      "wsf",
      "svg"
    ],
    case_insensitive: !0,
    unicodeRegex: !0,
    contains: [
      {
        className: "meta",
        begin: /<![a-z]/,
        end: />/,
        relevance: 10,
        contains: [
          at,
          z,
          V,
          I,
          {
            begin: /\[/,
            end: /\]/,
            contains: [
              {
                className: "meta",
                begin: /<![a-z]/,
                end: />/,
                contains: [
                  at,
                  I,
                  z,
                  V
                ]
              }
            ]
          }
        ]
      },
      g.COMMENT(
        /<!--/,
        /-->/,
        { relevance: 10 }
      ),
      {
        begin: /<!\[CDATA\[/,
        end: /\]\]>/,
        relevance: 10
      },
      J,
      // xml processing instructions
      {
        className: "meta",
        end: /\?>/,
        variants: [
          {
            begin: /<\?xml/,
            relevance: 10,
            contains: [
              z
            ]
          },
          {
            begin: /<\?[a-z][a-z0-9]+/
          }
        ]
      },
      {
        className: "tag",
        /*
        The lookahead pattern (?=...) ensures that 'begin' only matches
        '<style' as a single word, followed by a whitespace or an
        ending bracket.
        */
        begin: /<style(?=\s|>)/,
        end: />/,
        keywords: { name: "style" },
        contains: [E],
        starts: {
          end: /<\/style>/,
          returnEnd: !0,
          subLanguage: "css"
        }
      },
      {
        className: "tag",
        // See the comment in the <style tag about the lookahead pattern
        begin: /<script(?=\s|>)/,
        end: />/,
        keywords: { name: "script" },
        contains: [E],
        starts: {
          end: /<\/script>/,
          returnEnd: !0,
          subLanguage: "javascript"
        }
      },
      // we need this for now for jSX
      {
        className: "tag",
        begin: /<>|<\/>/
      },
      // open tag
      {
        className: "tag",
        begin: R.concat(
          /</,
          R.lookahead(R.concat(
            N,
            // <tag/>
            // <tag>
            // <tag ...
            R.either(/\/>/, />/, /\s/)
          ))
        ),
        end: /\/?>/,
        contains: [
          {
            className: "name",
            begin: N,
            relevance: 0,
            starts: E
          }
        ]
      },
      // close tag
      {
        className: "tag",
        begin: R.concat(
          /<\//,
          R.lookahead(R.concat(
            N,
            />/
          ))
        ),
        contains: [
          {
            className: "name",
            begin: N,
            relevance: 0
          },
          {
            begin: />/,
            relevance: 0,
            endsParent: !0
          }
        ]
      }
    ]
  };
}
function Zh(g) {
  const R = "true false yes no null", N = "[\\w#;/?:@&=+$,.~*'()[\\]]+", r = {
    className: "attr",
    variants: [
      // added brackets support and special char support
      { begin: /[\w*@][\w*@ :()\./-]*:(?=[ \t]|$)/ },
      {
        // double quoted keys - with brackets and special char support
        begin: /"[\w*@][\w*@ :()\./-]*":(?=[ \t]|$)/
      },
      {
        // single quoted keys - with brackets and special char support
        begin: /'[\w*@][\w*@ :()\./-]*':(?=[ \t]|$)/
      }
    ]
  }, J = {
    className: "template-variable",
    variants: [
      {
        // jinja templates Ansible
        begin: /\{\{/,
        end: /\}\}/
      },
      {
        // Ruby i18n
        begin: /%\{/,
        end: /\}/
      }
    ]
  }, at = {
    className: "string",
    relevance: 0,
    begin: /'/,
    end: /'/,
    contains: [
      {
        match: /''/,
        scope: "char.escape",
        relevance: 0
      }
    ]
  }, I = {
    className: "string",
    relevance: 0,
    variants: [
      {
        begin: /"/,
        end: /"/
      },
      { begin: /\S+/ }
    ],
    contains: [
      g.BACKSLASH_ESCAPE,
      J
    ]
  }, V = g.inherit(I, { variants: [
    {
      begin: /'/,
      end: /'/,
      contains: [
        {
          begin: /''/,
          relevance: 0
        }
      ]
    },
    {
      begin: /"/,
      end: /"/
    },
    { begin: /[^\s,{}[\]]+/ }
  ] }), Z = {
    className: "number",
    begin: "\\b" + "[0-9]{4}(-[0-9][0-9]){0,2}" + "([Tt \\t][0-9][0-9]?(:[0-9][0-9]){2})?" + "(\\.[0-9]*)?" + "([ \\t])*(Z|[-+][0-9][0-9]?(:[0-9][0-9])?)?" + "\\b"
  }, ut = {
    end: ",",
    endsWithParent: !0,
    excludeEnd: !0,
    keywords: R,
    relevance: 0
  }, rt = {
    begin: /\{/,
    end: /\}/,
    contains: [ut],
    illegal: "\\n",
    relevance: 0
  }, F = {
    begin: "\\[",
    end: "\\]",
    contains: [ut],
    illegal: "\\n",
    relevance: 0
  }, Mt = [
    r,
    {
      className: "meta",
      begin: "^---\\s*$",
      relevance: 10
    },
    {
      // multi line string
      // Blocks start with a | or > followed by a newline
      //
      // Indentation of subsequent lines must be the same to
      // be considered part of the block
      className: "string",
      begin: "[\\|>]([1-9]?[+-])?[ ]*\\n( +)[^ ][^\\n]*\\n(\\2[^\\n]+\\n?)*"
    },
    {
      // Ruby/Rails erb
      begin: "<%[%=-]?",
      end: "[%-]?%>",
      subLanguage: "ruby",
      excludeBegin: !0,
      excludeEnd: !0,
      relevance: 0
    },
    {
      // named tags
      className: "type",
      begin: "!\\w+!" + N
    },
    // https://yaml.org/spec/1.2/spec.html#id2784064
    {
      // verbatim tags
      className: "type",
      begin: "!<" + N + ">"
    },
    {
      // primary tags
      className: "type",
      begin: "!" + N
    },
    {
      // secondary tags
      className: "type",
      begin: "!!" + N
    },
    {
      // fragment id &ref
      className: "meta",
      begin: "&" + g.UNDERSCORE_IDENT_RE + "$"
    },
    {
      // fragment reference *ref
      className: "meta",
      begin: "\\*" + g.UNDERSCORE_IDENT_RE + "$"
    },
    {
      // array listing
      className: "bullet",
      // TODO: remove |$ hack when we have proper look-ahead support
      begin: "-(?=[ ]|$)",
      relevance: 0
    },
    g.HASH_COMMENT_MODE,
    {
      beginKeywords: R,
      keywords: { literal: R }
    },
    Z,
    // numbers are any valid C-style number that
    // sit isolated from other words
    {
      className: "number",
      begin: g.C_NUMBER_RE + "\\b",
      relevance: 0
    },
    rt,
    F,
    at,
    I
  ], ht = [...Mt];
  return ht.pop(), ht.push(V), ut.contains = ht, {
    name: "YAML",
    case_insensitive: !0,
    aliases: ["yml"],
    contains: Mt
  };
}
function jh(g) {
  const R = g.regex, N = g.COMMENT("--", "$"), r = {
    scope: "string",
    variants: [
      {
        begin: /'/,
        end: /'/,
        contains: [{ match: /''/ }]
      }
    ]
  }, J = {
    begin: /"/,
    end: /"/,
    contains: [{ match: /""/ }]
  }, at = [
    "true",
    "false",
    // Not sure it's correct to call NULL literal, and clauses like IS [NOT] NULL look strange that way.
    // "null",
    "unknown"
  ], I = [
    "double precision",
    "large object",
    "with timezone",
    "without timezone"
  ], V = [
    "bigint",
    "binary",
    "blob",
    "boolean",
    "char",
    "character",
    "clob",
    "date",
    "dec",
    "decfloat",
    "decimal",
    "float",
    "int",
    "integer",
    "interval",
    "nchar",
    "nclob",
    "national",
    "numeric",
    "real",
    "row",
    "smallint",
    "time",
    "timestamp",
    "varchar",
    "varying",
    // modifier (character varying)
    "varbinary"
  ], z = [
    "add",
    "asc",
    "collation",
    "desc",
    "final",
    "first",
    "last",
    "view"
  ], E = [
    "abs",
    "acos",
    "all",
    "allocate",
    "alter",
    "and",
    "any",
    "are",
    "array",
    "array_agg",
    "array_max_cardinality",
    "as",
    "asensitive",
    "asin",
    "asymmetric",
    "at",
    "atan",
    "atomic",
    "authorization",
    "avg",
    "begin",
    "begin_frame",
    "begin_partition",
    "between",
    "bigint",
    "binary",
    "blob",
    "boolean",
    "both",
    "by",
    "call",
    "called",
    "cardinality",
    "cascaded",
    "case",
    "cast",
    "ceil",
    "ceiling",
    "char",
    "char_length",
    "character",
    "character_length",
    "check",
    "classifier",
    "clob",
    "close",
    "coalesce",
    "collate",
    "collect",
    "column",
    "commit",
    "condition",
    "connect",
    "constraint",
    "contains",
    "convert",
    "copy",
    "corr",
    "corresponding",
    "cos",
    "cosh",
    "count",
    "covar_pop",
    "covar_samp",
    "create",
    "cross",
    "cube",
    "cume_dist",
    "current",
    "current_catalog",
    "current_date",
    "current_default_transform_group",
    "current_path",
    "current_role",
    "current_row",
    "current_schema",
    "current_time",
    "current_timestamp",
    "current_path",
    "current_role",
    "current_transform_group_for_type",
    "current_user",
    "cursor",
    "cycle",
    "date",
    "day",
    "deallocate",
    "dec",
    "decimal",
    "decfloat",
    "declare",
    "default",
    "define",
    "delete",
    "dense_rank",
    "deref",
    "describe",
    "deterministic",
    "disconnect",
    "distinct",
    "double",
    "drop",
    "dynamic",
    "each",
    "element",
    "else",
    "empty",
    "end",
    "end_frame",
    "end_partition",
    "end-exec",
    "equals",
    "escape",
    "every",
    "except",
    "exec",
    "execute",
    "exists",
    "exp",
    "external",
    "extract",
    "false",
    "fetch",
    "filter",
    "first_value",
    "float",
    "floor",
    "for",
    "foreign",
    "frame_row",
    "free",
    "from",
    "full",
    "function",
    "fusion",
    "get",
    "global",
    "grant",
    "group",
    "grouping",
    "groups",
    "having",
    "hold",
    "hour",
    "identity",
    "in",
    "indicator",
    "initial",
    "inner",
    "inout",
    "insensitive",
    "insert",
    "int",
    "integer",
    "intersect",
    "intersection",
    "interval",
    "into",
    "is",
    "join",
    "json_array",
    "json_arrayagg",
    "json_exists",
    "json_object",
    "json_objectagg",
    "json_query",
    "json_table",
    "json_table_primitive",
    "json_value",
    "lag",
    "language",
    "large",
    "last_value",
    "lateral",
    "lead",
    "leading",
    "left",
    "like",
    "like_regex",
    "listagg",
    "ln",
    "local",
    "localtime",
    "localtimestamp",
    "log",
    "log10",
    "lower",
    "match",
    "match_number",
    "match_recognize",
    "matches",
    "max",
    "member",
    "merge",
    "method",
    "min",
    "minute",
    "mod",
    "modifies",
    "module",
    "month",
    "multiset",
    "national",
    "natural",
    "nchar",
    "nclob",
    "new",
    "no",
    "none",
    "normalize",
    "not",
    "nth_value",
    "ntile",
    "null",
    "nullif",
    "numeric",
    "octet_length",
    "occurrences_regex",
    "of",
    "offset",
    "old",
    "omit",
    "on",
    "one",
    "only",
    "open",
    "or",
    "order",
    "out",
    "outer",
    "over",
    "overlaps",
    "overlay",
    "parameter",
    "partition",
    "pattern",
    "per",
    "percent",
    "percent_rank",
    "percentile_cont",
    "percentile_disc",
    "period",
    "portion",
    "position",
    "position_regex",
    "power",
    "precedes",
    "precision",
    "prepare",
    "primary",
    "procedure",
    "ptf",
    "range",
    "rank",
    "reads",
    "real",
    "recursive",
    "ref",
    "references",
    "referencing",
    "regr_avgx",
    "regr_avgy",
    "regr_count",
    "regr_intercept",
    "regr_r2",
    "regr_slope",
    "regr_sxx",
    "regr_sxy",
    "regr_syy",
    "release",
    "result",
    "return",
    "returns",
    "revoke",
    "right",
    "rollback",
    "rollup",
    "row",
    "row_number",
    "rows",
    "running",
    "savepoint",
    "scope",
    "scroll",
    "search",
    "second",
    "seek",
    "select",
    "sensitive",
    "session_user",
    "set",
    "show",
    "similar",
    "sin",
    "sinh",
    "skip",
    "smallint",
    "some",
    "specific",
    "specifictype",
    "sql",
    "sqlexception",
    "sqlstate",
    "sqlwarning",
    "sqrt",
    "start",
    "static",
    "stddev_pop",
    "stddev_samp",
    "submultiset",
    "subset",
    "substring",
    "substring_regex",
    "succeeds",
    "sum",
    "symmetric",
    "system",
    "system_time",
    "system_user",
    "table",
    "tablesample",
    "tan",
    "tanh",
    "then",
    "time",
    "timestamp",
    "timezone_hour",
    "timezone_minute",
    "to",
    "trailing",
    "translate",
    "translate_regex",
    "translation",
    "treat",
    "trigger",
    "trim",
    "trim_array",
    "true",
    "truncate",
    "uescape",
    "union",
    "unique",
    "unknown",
    "unnest",
    "update",
    "upper",
    "user",
    "using",
    "value",
    "values",
    "value_of",
    "var_pop",
    "var_samp",
    "varbinary",
    "varchar",
    "varying",
    "versioning",
    "when",
    "whenever",
    "where",
    "width_bucket",
    "window",
    "with",
    "within",
    "without",
    "year"
  ], j = [
    "abs",
    "acos",
    "array_agg",
    "asin",
    "atan",
    "avg",
    "cast",
    "ceil",
    "ceiling",
    "coalesce",
    "corr",
    "cos",
    "cosh",
    "count",
    "covar_pop",
    "covar_samp",
    "cume_dist",
    "dense_rank",
    "deref",
    "element",
    "exp",
    "extract",
    "first_value",
    "floor",
    "json_array",
    "json_arrayagg",
    "json_exists",
    "json_object",
    "json_objectagg",
    "json_query",
    "json_table",
    "json_table_primitive",
    "json_value",
    "lag",
    "last_value",
    "lead",
    "listagg",
    "ln",
    "log",
    "log10",
    "lower",
    "max",
    "min",
    "mod",
    "nth_value",
    "ntile",
    "nullif",
    "percent_rank",
    "percentile_cont",
    "percentile_disc",
    "position",
    "position_regex",
    "power",
    "rank",
    "regr_avgx",
    "regr_avgy",
    "regr_count",
    "regr_intercept",
    "regr_r2",
    "regr_slope",
    "regr_sxx",
    "regr_sxy",
    "regr_syy",
    "row_number",
    "sin",
    "sinh",
    "sqrt",
    "stddev_pop",
    "stddev_samp",
    "substring",
    "substring_regex",
    "sum",
    "tan",
    "tanh",
    "translate",
    "translate_regex",
    "treat",
    "trim",
    "trim_array",
    "unnest",
    "upper",
    "value_of",
    "var_pop",
    "var_samp",
    "width_bucket"
  ], H = [
    "current_catalog",
    "current_date",
    "current_default_transform_group",
    "current_path",
    "current_role",
    "current_schema",
    "current_transform_group_for_type",
    "current_user",
    "session_user",
    "system_time",
    "system_user",
    "current_time",
    "localtime",
    "current_timestamp",
    "localtimestamp"
  ], Z = [
    "create table",
    "insert into",
    "primary key",
    "foreign key",
    "not null",
    "alter table",
    "add constraint",
    "grouping sets",
    "on overflow",
    "character set",
    "respect nulls",
    "ignore nulls",
    "nulls first",
    "nulls last",
    "depth first",
    "breadth first"
  ], ut = j, rt = [
    ...E,
    ...z
  ].filter((St) => !j.includes(St)), F = {
    scope: "variable",
    match: /@[a-z0-9][a-z0-9_]*/
  }, Mt = {
    scope: "operator",
    match: /[-+*/=%^~]|&&?|\|\|?|!=?|<(?:=>?|<|>)?|>[>=]?/,
    relevance: 0
  }, ht = {
    match: R.concat(/\b/, R.either(...ut), /\s*\(/),
    relevance: 0,
    keywords: { built_in: ut }
  };
  function Ht(St) {
    return R.concat(
      /\b/,
      R.either(...St.map((pt) => pt.replace(/\s+/, "\\s+"))),
      /\b/
    );
  }
  const Nt = {
    scope: "keyword",
    match: Ht(Z),
    relevance: 0
  };
  function jt(St, {
    exceptions: pt,
    when: tt
  } = {}) {
    const qt = tt;
    return pt = pt || [], St.map((Qt) => Qt.match(/\|\d+$/) || pt.includes(Qt) ? Qt : qt(Qt) ? `${Qt}|0` : Qt);
  }
  return {
    name: "SQL",
    case_insensitive: !0,
    // does not include {} or HTML tags `</`
    illegal: /[{}]|<\//,
    keywords: {
      $pattern: /\b[\w\.]+/,
      keyword: jt(rt, { when: (St) => St.length < 3 }),
      literal: at,
      type: V,
      built_in: H
    },
    contains: [
      {
        scope: "type",
        match: Ht(I)
      },
      Nt,
      ht,
      F,
      r,
      J,
      g.C_NUMBER_MODE,
      g.C_BLOCK_COMMENT_MODE,
      N,
      Mt
    ]
  };
}
function Qh(g) {
  const R = g.regex, N = {
    begin: /<\/?[A-Za-z_]/,
    end: ">",
    subLanguage: "xml",
    relevance: 0
  }, r = { match: /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/ }, J = {
    className: "code",
    variants: [
      // TODO: fix to allow these to work with sublanguage also
      { begin: "(`{3,})[^`](.|\\n)*?\\1`*[ ]*" },
      { begin: "(~{3,})[^~](.|\\n)*?\\1~*[ ]*" },
      // needed to allow markdown as a sublanguage to work
      {
        begin: "```",
        end: "```+[ ]*$"
      },
      {
        begin: "~~~",
        end: "~~~+[ ]*$"
      },
      { begin: "`.+?`" },
      {
        begin: "(?=^( {4}|\\t))",
        // use contains to gobble up multiple lines to allow the block to be whatever size
        // but only have a single open/close tag vs one per line
        contains: [
          {
            begin: "^( {4}|\\t)",
            end: "(\\n)$"
          }
        ],
        relevance: 0
      }
    ]
  }, at = {
    className: "bullet",
    begin: "^[ 	]*([*+-]|(\\d+\\.))(?=\\s+)",
    end: "\\s+",
    excludeEnd: !0
  }, I = {
    begin: /^\[[^\n]+\]:/,
    returnBegin: !0,
    contains: [
      {
        className: "symbol",
        begin: /\[/,
        end: /\]/,
        excludeBegin: !0,
        excludeEnd: !0
      },
      {
        className: "link",
        begin: /:\s*/,
        end: /$/,
        excludeBegin: !0
      }
    ]
  }, V = /[A-Za-z][A-Za-z0-9+.-]*/, z = {
    variants: [
      // too much like nested array access in so many languages
      // to have any real relevance
      {
        begin: /\[.+?\]\[.*?\]/,
        relevance: 0
      },
      // popular internet URLs
      {
        begin: /\[.+?\]\(((data|javascript|mailto):|(?:http|ftp)s?:\/\/).*?\)/,
        relevance: 2
      },
      {
        begin: R.concat(/\[.+?\]\(/, V, /:\/\/.*?\)/),
        relevance: 2
      },
      // relative urls
      {
        begin: /\[.+?\]\([./?&#].*?\)/,
        relevance: 1
      },
      // whatever else, lower relevance (might not be a link at all)
      {
        begin: /\[.*?\]\(.*?\)/,
        relevance: 0
      }
    ],
    returnBegin: !0,
    contains: [
      {
        // empty strings for alt or link text
        match: /\[(?=\])/
      },
      {
        className: "string",
        relevance: 0,
        begin: "\\[",
        end: "\\]",
        excludeBegin: !0,
        returnEnd: !0
      },
      {
        className: "link",
        relevance: 0,
        begin: "\\]\\(",
        end: "\\)",
        excludeBegin: !0,
        excludeEnd: !0
      },
      {
        className: "symbol",
        relevance: 0,
        begin: "\\]\\[",
        end: "\\]",
        excludeBegin: !0,
        excludeEnd: !0
      }
    ]
  }, E = {
    className: "strong",
    contains: [],
    // defined later
    variants: [
      {
        begin: /_{2}(?!\s)/,
        end: /_{2}/
      },
      {
        begin: /\*{2}(?!\s)/,
        end: /\*{2}/
      }
    ]
  }, j = {
    className: "emphasis",
    contains: [],
    // defined later
    variants: [
      {
        begin: /\*(?![*\s])/,
        end: /\*/
      },
      {
        begin: /_(?![_\s])/,
        end: /_/,
        relevance: 0
      }
    ]
  }, H = g.inherit(E, { contains: [] }), Z = g.inherit(j, { contains: [] });
  E.contains.push(Z), j.contains.push(H);
  let ut = [
    N,
    z
  ];
  return [
    E,
    j,
    H,
    Z
  ].forEach((ht) => {
    ht.contains = ht.contains.concat(ut);
  }), ut = ut.concat(E, j), {
    name: "Markdown",
    aliases: [
      "md",
      "mkdown",
      "mkd"
    ],
    contains: [
      {
        className: "section",
        variants: [
          {
            begin: "^#{1,6}",
            end: "$",
            contains: ut
          },
          {
            begin: "(?=^.+?\\n[=-]{2,}$)",
            contains: [
              { begin: "^[=-]*$" },
              {
                begin: "^",
                end: "\\n",
                contains: ut
              }
            ]
          }
        ]
      },
      N,
      at,
      // must come before BOLD/ITALIC so that a `***` or `___` thematic break
      // isn't mistaken for the start of bold text
      r,
      E,
      j,
      {
        className: "quote",
        begin: "^>\\s+",
        contains: ut,
        end: "$"
      },
      J,
      z,
      I,
      {
        //https://spec.commonmark.org/0.31.2/#entity-references
        scope: "literal",
        match: /&([a-zA-Z0-9]+|#[0-9]{1,7}|#[Xx][0-9a-fA-F]{1,6});/
      }
    ]
  };
}
function Kh(g) {
  const R = g.regex;
  return {
    name: "Diff",
    aliases: ["patch"],
    contains: [
      {
        className: "meta",
        relevance: 10,
        match: R.either(
          /^@@ +-\d+,\d+ +\+\d+,\d+ +@@/,
          // @@ -1,2 +1,2 @@
          /^@@ +-\d+ +\+\d+,\d+ +@@/,
          // @@ -1 +1,2 @@
          /^@@ +-\d+,\d+ +\+\d+ +@@/,
          // @@ -1,2 +1 @@
          /^@@ +-\d+ +\+\d+ +@@/,
          // @@ -1 +1 @@
          /^\*\*\* +\d+,\d+ +\*\*\*\*$/,
          /^--- +\d+,\d+ +----$/
        )
      },
      {
        className: "comment",
        variants: [
          {
            begin: R.either(
              /Index: /,
              /^index/,
              /={3,}/,
              /^-{3}/,
              /^\*{3} /,
              /^\+{3}/,
              /^diff --git/
            ),
            end: /$/
          },
          { match: /^\*{15}$/ }
        ]
      },
      {
        className: "addition",
        begin: /^\+/,
        end: /$/
      },
      {
        className: "deletion",
        begin: /^-/,
        end: /$/
      },
      {
        className: "addition",
        begin: /^!/,
        end: /$/
      }
    ]
  };
}
for (const [g, R] of Object.entries({ javascript: Ah, typescript: Nh, json: zh, python: Dh, bash: Ch, css: wh, xml: Xh, yaml: Zh, sql: jh, markdown: Qh, diff: Kh })) ns.registerLanguage(g, R);
const ug = { js: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript", py: "python", sh: "bash", shell: "bash", html: "xml", yml: "yaml", md: "markdown" }, Vh = (g) => String(g).replace(/[&<>"]/g, (R) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[R]);
function Wh(g = "") {
  const R = String(g).split(/[\\/]/).at(-1).toLowerCase(), N = R.includes(".") ? R.split(".").at(-1) : R;
  return { mjs: "javascript", cjs: "javascript", mts: "typescript", cts: "typescript", svg: "xml", vue: "xml", bashrc: "bash", zsh: "bash", zshrc: "bash" }[N] || ug[N] || N;
}
function Ih(g, R = "") {
  const N = String(R).trim().split(/\s+/)[0].toLowerCase(), r = ug[N] || N;
  return g.length <= 8e4 && ns.getLanguage(r) ? ns.highlight(g, { language: r, ignoreIllegals: !0 }).value : Vh(g);
}
export {
  $h as R,
  Jh as a,
  mh as b,
  Wh as c,
  as as d,
  Jd as g,
  Ih as h,
  kh as j,
  yh as r
};
