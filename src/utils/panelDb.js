const mysqlPool = require("../config/mysqlJobDb");

async function query(sql, params = []) {
  const [rows] = await mysqlPool.query(sql, params);
  return { rows: Array.isArray(rows) ? rows : [], result: rows };
}

async function exec(sql, params = []) {
  const [result] = await mysqlPool.query(sql, params);
  return result;
}

module.exports = { query, exec };
