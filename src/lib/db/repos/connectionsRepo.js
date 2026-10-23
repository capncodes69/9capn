import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

// The DB layer must not reach into the OAuth layer for this, so the decoder is
// duplicated here rather than imported from `lib/oauth/providerHelpers`. It is
// only used to read the *identity* claims (sub/email/preferred_username) off a
// CodeBuddy token — never to trust anything else in the payload.
function decodeJwtPayload(token) {
  try {
    if (!token || typeof token !== "string") return null;
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

// A CodeBuddy token can arrive in three places depending on how the row was
// created: the device flow stores it as `accessToken` (+ a refresh token), while
// API-key mode pastes the same JWT into `apiKey`, which the executor sends as the
// bearer. All three are read, or the same account dedups on one path and stacks
// rows on the other.
function findCodeBuddyJwt(data) {
  return decodeJwtPayload(data?.accessToken)
    || decodeJwtPayload(data?.refreshToken)
    || decodeJwtPayload(data?.apiKey);
}

const CODEBUDDY_PROVIDERS = new Set(["codebuddy-intl", "codebuddy-cn"]);

/**
 * Identity for a CodeBuddy connection: the token's `sub` when present, else its
 * email, else whatever the caller supplied. Returns `null` when nothing at all is
 * available, which means "cannot prove this is a duplicate" — the insert then
 * proceeds, so a row without an identity is never silently merged into another.
 */
function codeBuddyIdentity(data) {
  const jwt = findCodeBuddyJwt(data);
  return jwt?.sub || data?.providerSpecificData?.userId || null;
}

function codeBuddyEmail(data) {
  const jwt = findCodeBuddyJwt(data);
  return data?.email || jwt?.email || null;
}

const OPTIONAL_FIELDS = [
  "displayName", "email", "globalPriority", "defaultModel",
  "accessToken", "refreshToken", "expiresAt", "tokenType",
  "scope", "projectId", "apiKey", "testStatus",
  "lastTested", "lastError", "lastErrorAt", "rateLimitedUntil", "expiresIn", "errorCode",
  "consecutiveUseCount", "idToken", "lastRefreshAt",
];

const MODEL_LOCK_PREFIX = "modelLock_";

function resetHealthStateOnActivation(existing, patch) {
  if (patch?.testStatus !== "active") return patch;

  const normalized = {
    ...patch,
    testStatus: "active",
    lastError: Object.hasOwn(patch, "lastError") ? patch.lastError : null,
    lastErrorAt: Object.hasOwn(patch, "lastErrorAt") ? patch.lastErrorAt : null,
    errorCode: null,
    rateLimitedUntil: null,
    backoffLevel: 0,
  };

  for (const key of Object.keys(existing || {})) {
    if (key.startsWith(MODEL_LOCK_PREFIX)) normalized[key] = null;
  }

  return normalized;
}

function rowToConn(row) {
  if (!row) return null;
  const extra = parseJson(row.data, {});
  return {
    ...extra,
    id: row.id,
    provider: row.provider,
    authType: row.authType,
    name: row.name,
    email: row.email,
    priority: row.priority,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function connToRow(c) {
  const { id, provider, authType, name, email, priority, isActive, createdAt, updatedAt, ...rest } = c;
  return {
    id,
    provider,
    authType,
    name: name ?? null,
    email: email ?? null,
    priority: priority ?? null,
    isActive: isActive === false ? 0 : 1,
    data: stringifyJson(rest),
    createdAt,
    updatedAt,
  };
}

function upsert(db, c) {
  const r = connToRow(c);
  db.run(
    `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       provider=excluded.provider, authType=excluded.authType, name=excluded.name,
       email=excluded.email, priority=excluded.priority, isActive=excluded.isActive,
       data=excluded.data, updatedAt=excluded.updatedAt`,
    [r.id, r.provider, r.authType, r.name, r.email, r.priority, r.isActive, r.data, r.createdAt, r.updatedAt]
  );
}

function deriveConnectionName(data, fallbackName) {
  if (data.provider === "github") {
    return data.providerSpecificData?.githubLogin
      || data.providerSpecificData?.githubEmail
      || data.email
      || data.providerSpecificData?.githubName
      || fallbackName;
  }
  if (CODEBUDDY_PROVIDERS.has(data.provider)) {
    const jwt = findCodeBuddyJwt(data);
    return jwt?.preferred_username
      || jwt?.email
      || data.displayName
      || data.email
      || fallbackName;
  }
  return fallbackName;
}

export async function getProviderConnections(filter = {}) {
  const db = await getAdapter();
  const where = [];
  const params = [];
  if (filter.provider) { where.push("provider = ?"); params.push(filter.provider); }
  if (filter.isActive !== undefined) { where.push("isActive = ?"); params.push(filter.isActive ? 1 : 0); }
  const sql = `SELECT * FROM providerConnections${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
  const rows = db.all(sql, params);
  const list = rows.map(rowToConn);
  list.sort((a, b) => (a.priority || 999) - (b.priority || 999));
  return list;
}

export async function getProviderConnectionById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM providerConnections WHERE id = ?`, [id]);
  return rowToConn(row);
}

// Internal sync reorder — must be called INSIDE a transaction.
//
// Normalizes priorities to a contiguous 1..N after a DELETE or an explicit
// reorder, so gaps don't accumulate over time.
//
// Deliberately NOT called on insert: a new connection already gets
// MAX(priority)+1, which sorts after every existing row, so the order is
// identical with or without the rewrite. Skipping it there is what makes
// import O(1) per key instead of O(pool) — see createProviderConnection.
function reorderInTx(db, providerId) {
  const list = db.all(`SELECT * FROM providerConnections WHERE provider = ?`, [providerId]).map(rowToConn);
  list.sort((a, b) => {
    const pDiff = (a.priority || 0) - (b.priority || 0);
    if (pDiff !== 0) return pDiff;
    return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
  });
  list.forEach((c, i) => {
    const want = i + 1;
    if ((c.priority || 0) !== want) {
      db.run(`UPDATE providerConnections SET priority = ? WHERE id = ?`, [want, c.id]);
    }
  });
}

export async function createProviderConnection(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  let result;

  db.transaction(() => {
    // apikey connections are deduped by name and need only the current max
    // priority, so query for those directly instead of loading the whole pool
    // (O(pool) per key — the other half of the import cost in #4311). The oauth
    // branch below still scans, because its identity rules compare fields
    // inside providerSpecificData and have no single-column equivalent.
    //
    // CodeBuddy is excluded from the narrow query: its identity is matched
    // across *both* authTypes (a JWT pasted as an API key and the same JWT from
    // the device flow are one account), which a `authType = 'apikey'` filter
    // cannot see. Its pools are small, so the full scan is the right trade.
    const isApikey = data.authType === "apikey" && !!data.name && !CODEBUDDY_PROVIDERS.has(data.provider);
    const all = isApikey
      ? db.all(
          `SELECT * FROM providerConnections WHERE provider = ? AND authType = ? AND name = ?`,
          [data.provider, "apikey", data.name]
        ).map(rowToConn)
      : db.all(`SELECT * FROM providerConnections WHERE provider = ?`, [data.provider]).map(rowToConn);
    const poolSize = isApikey
      ? db.get(`SELECT COUNT(*) AS n FROM providerConnections WHERE provider = ?`, [data.provider])?.n ?? all.length
      : all.length;

    let existing = null;

    // CodeBuddy answers the device flow with a JWT and no profile object, so a
    // re-login often arrives with no `email` at all. The generic oauth branch
    // below is gated on `data.email`, so those re-logins fell through and every
    // import of the same account added another row — the second one then
    // shadowed the first on rotation. Identify on the token instead.
    if (CODEBUDDY_PROVIDERS.has(data.provider)) {
      const incomingSub = codeBuddyIdentity(data);
      const incomingEmail = codeBuddyEmail(data);
      existing = all.find(c => {
        if (c.provider !== data.provider) return false;
        const rowSub = codeBuddyIdentity(c);
        // `sub` is the stable account id: two rows with the same one are the
        // same account regardless of how the credential was stored.
        if (incomingSub && rowSub) return incomingSub === rowSub;
        // One side has no `sub` (an older row, or an opaque token): fall back to
        // email, but only when both sides actually have one — collapsing onto a
        // bare-email row would overwrite the account that owned it.
        const rowEmail = codeBuddyEmail(c);
        if (incomingEmail && rowEmail) return incomingEmail === rowEmail;
        return false;
      });
    } else if (data.authType === "oauth" && data.email) {
      const incomingUsername = data.providerSpecificData?.username;
      const incomingWs = data.providerSpecificData?.chatgptAccountId;
      existing = all.find(c => {
        if (c.authType !== "oauth" || c.email !== data.email) return false;

        // Codex/OpenAI can issue multiple OAuth grants for the same email.
        // Refresh tokens are rotated single-use; collapsing a new login onto an
        // existing bare-email row overwrites the first account's token pair and
        // makes it look "invalid" after adding a second account. Only update an
        // existing Codex row when both rows expose the same ChatGPT account ID.
        if (data.provider === "codex") {
          const existingWs = c.providerSpecificData?.chatgptAccountId;
          return !!incomingWs && !!existingWs && incomingWs === existingWs;
        }

        // Workspace providers use workspace ID when both sides have it
        const existingWs = c.providerSpecificData?.chatgptAccountId;
        if (incomingWs && existingWs) return incomingWs === existingWs;
        if (incomingWs && !existingWs) return false;
        if (!incomingWs && existingWs) return false;
        // Non-workspace providers: match on (email + username) so cross-IdP
        // accounts don't overwrite each other. Require username on both sides
        // — if only one side has it, treat as a distinct identity rather than
        // collapsing onto the bare-email fallback (which would re-introduce
        // the cross-IdP overwrite).
        const existingUsername = c.providerSpecificData?.username;
        if (incomingUsername && existingUsername) {
          return incomingUsername === existingUsername;
        }
        if (incomingUsername || existingUsername) return false;
        return true;
      });
    } else if (data.authType === "apikey" && data.name) {
      existing = all.find(c => c.authType === "apikey" && c.name === data.name);
    }
    // access_token: never dedup — user manages duplicates manually

    if (existing) {
      // Name collision on an apikey connection used to silently replace the
      // stored apiKey, so a script that reused names ("Key 1", "Key 2", …)
      // destroyed existing pool entries with no 409 and no warning. Callers that
      // genuinely mean "update this one" pass allowOverwrite; everyone else gets
      // a typed error naming the row that would have been replaced. #4311
      if (data.allowOverwrite === false) {
        const err = new Error(
          `A connection named "${existing.name}" already exists for provider "${data.provider}". ` +
          `Pass allowOverwrite: true to replace it.`
        );
        err.code = "PROVIDER_NAME_CONFLICT";
        err.existingId = existing.id;
        err.existingName = existing.name;
        throw err;
      }
      const normalized = resetHealthStateOnActivation(existing, data);
      const merged = { ...existing, ...normalized, updatedAt: now };
      upsert(db, merged);
      result = merged;
      return;
    }

    let connectionName = data.name || null;
    if (!connectionName && (data.authType === "oauth" || data.authType === "access_token")) {
      connectionName = deriveConnectionName(data, data.email || `Account ${poolSize + 1}`);
    }
    let connectionPriority = data.priority;
    if (!connectionPriority) {
      // MAX(priority)+1 in SQL rather than a reduce over the loaded pool: the
      // apikey path no longer has the whole pool in memory, and the aggregate
      // is served by the index instead of a row scan. #4311
      const maxRow = db.get(`SELECT MAX(priority) AS m FROM providerConnections WHERE provider = ?`, [data.provider]);
      connectionPriority = (maxRow?.m || 0) + 1;
    }

    const conn = {
      id: uuidv4(),
      provider: data.provider,
      authType: data.authType || "oauth",
      name: connectionName,
      priority: connectionPriority,
      isActive: data.isActive !== undefined ? data.isActive : true,
      createdAt: now,
      updatedAt: now,
    };
    for (const f of OPTIONAL_FIELDS) {
      if (data[f] !== undefined && data[f] !== null) conn[f] = data[f];
    }
    if (data.providerSpecificData && Object.keys(data.providerSpecificData).length > 0) {
      conn.providerSpecificData = data.providerSpecificData;
    }
    if (data.email !== undefined) conn.email = data.email;

    upsert(db, conn);
    // No reorderInTx here. `conn.priority` is already MAX(priority)+1, so the
    // row sorts last and the resulting order is what reorderInTx would have
    // produced anyway. The rewrite cost ~2N statements per insert — O(pool) —
    // which made a 5k-key import O(n*m): ~25M statements at a 5k pool, and it
    // serialized every parallel writer on the same transaction. #4311
    result = conn;
  });

  return result;
}

// Critical: OAuth refresh token race — atomic merge inside transaction
export async function updateProviderConnection(id, data) {
  const db = await getAdapter();
  let result;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM providerConnections WHERE id = ?`, [id]);
    if (!row) { result = null; return; }
    const existing = rowToConn(row);
    const normalized = resetHealthStateOnActivation(existing, data);
    const merged = { ...existing, ...normalized, updatedAt: new Date().toISOString() };
    upsert(db, merged);
    if (data.priority !== undefined) reorderInTx(db, existing.provider);
    result = merged;
  });
  return result;
}

export async function deleteProviderConnection(id) {
  const db = await getAdapter();
  let ok = false;
  db.transaction(() => {
    const row = db.get(`SELECT provider FROM providerConnections WHERE id = ?`, [id]);
    if (!row) return;
    db.run(`DELETE FROM providerConnections WHERE id = ?`, [id]);
    reorderInTx(db, row.provider);
    ok = true;
  });
  return ok;
}

export async function deleteProviderConnectionsByProvider(providerId) {
  const db = await getAdapter();
  const before = db.get(`SELECT COUNT(*) AS n FROM providerConnections WHERE provider = ?`, [providerId]);
  db.run(`DELETE FROM providerConnections WHERE provider = ?`, [providerId]);
  return before?.n || 0;
}

export async function reorderProviderConnections(providerId) {
  const db = await getAdapter();
  db.transaction(() => reorderInTx(db, providerId));
}

export async function cleanupProviderConnections() {
  const db = await getAdapter();
  const fieldsToCheck = [
    "displayName", "email", "globalPriority", "defaultModel",
    "accessToken", "refreshToken", "expiresAt", "tokenType",
    "scope", "projectId", "apiKey", "testStatus",
    "lastTested", "lastError", "lastErrorAt", "rateLimitedUntil", "expiresIn",
    "consecutiveUseCount",
  ];
  let cleaned = 0;
  db.transaction(() => {
    const rows = db.all(`SELECT * FROM providerConnections`);
    for (const row of rows) {
      const conn = rowToConn(row);
      let dirty = false;
      for (const f of fieldsToCheck) {
        if (conn[f] === null || conn[f] === undefined) {
          if (f in conn) { delete conn[f]; cleaned++; dirty = true; }
        }
      }
      if (conn.providerSpecificData && Object.keys(conn.providerSpecificData).length === 0) {
        delete conn.providerSpecificData;
        cleaned++;
        dirty = true;
      }
      if (dirty) upsert(db, conn);
    }
  });
  return cleaned;
}
