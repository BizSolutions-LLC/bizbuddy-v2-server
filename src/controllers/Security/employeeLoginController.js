// src/controllers/Security/employeeLoginController.js
//
// BB-137: Company panel → Requests & Logs → Employee Logins (admins only).
//   GET /api/employee-logins
//   GET /api/employee-logins/shared-devices
//   GET /api/employee-logins/employees/:userId

const { listLogins, employeeLogins, sharedDevices, EmployeeLoginError } = require("@services/Security/employeeLoginService");

const fail = (res, err, label) => {
  if (err instanceof EmployeeLoginError) return res.status(err.status).json({ message: err.message });
  console.error(`[BB-137] ${label} error:`, err);
  return res.status(500).json({ message: "Something went wrong." });
};

const getLogins = async (req, res) => {
  try {
    return res.json({ data: await listLogins(req.user, req.query) });
  } catch (err) {
    return fail(res, err, "getLogins");
  }
};

const getSharedDevices = async (req, res) => {
  try {
    return res.json({ data: await sharedDevices(req.user, req.query) });
  } catch (err) {
    return fail(res, err, "getSharedDevices");
  }
};

const getEmployeeLogins = async (req, res) => {
  try {
    return res.json({ data: await employeeLogins(req.user, req.params.userId, req.query) });
  } catch (err) {
    return fail(res, err, "getEmployeeLogins");
  }
};

module.exports = { getLogins, getSharedDevices, getEmployeeLogins };
