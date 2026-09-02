// src/controllers/Features/employeeController.js

const bcrypt = require("bcryptjs");
const { prisma } = require("@config/connection");
const { sendMail } = require("@utils/mailer");
const { renderWelcome } = require("@emails/renderTemplate");
const { validateSupervisorId } = require("@utils/supervisorValidation");

/**
 * Generate a unique username in the format: first initial + last name (e.g. ccorcuera)
 * If taken, appends an incrementing number: ccorcuera1, ccorcuera2, etc.
 */
async function generateUsername(firstName, lastName) {
  const base = (firstName.charAt(0) + lastName).toLowerCase().replace(/[^a-z0-9]/g, "");
  let username = base;
  let counter = 1;
  while (await prisma.user.findUnique({ where: { username } })) {
    username = `${base}${counter}`;
    counter++;
  }
  return username;
}

const getAllEmployees = async (req, res) => {
  try {
    const companyId = req.user.companyId;
    if (!companyId) {
      return res.status(400).json({ error: "No company associated with the employee." });
    }
    
    const employees = await prisma.user.findMany({
      where: { companyId },
      select: {
        id: true,
        email: true,
        username: true,
        role: true,
        status: true,
        hireDate: true,
        employeeId: true,
        createdAt: true,
        updatedAt: true,
        profile: {
          select: {
            firstName: true,
            lastName: true,
            phoneNumber: true,
            username: true,
          },
        },
        department: {
          select: { 
            id: true, 
            name: true,
            supervisor: {  
              select: {
                id: true,
                email: true,
                profile: {
                  select: {
                    firstName: true,
                    lastName: true
                  }
                }
              }
            }
          },
        },
        company: {
          select: { id: true, name: true },
        },
        employmentDetail: {
          select: {
            jobTitle: true,
            employmentStatus: true,
            exemptStatus: true,
            employmentType: true,
            workLocation: true,
            probationEndDate: true,
            timeZone: true,
            isDriver: true,
            supervisor: {
              select: {
                id: true,
                email: true,
                profile: {
                  select: {
                    firstName: true,
                    lastName: true
                  }
                }
              },
            },
          },
        },
      },
      orderBy: { id: "asc" },
    });
    
    return res.status(200).json({ data: employees, message: "Employees retrieved successfully." });
  } catch (error) {
    console.error("Error in getAllEmployees:", error);
    return res.status(500).json({ error: "Internal server error." });
  }
};

// BB-080: the employees a supervisor/admin/superadmin is allowed to act for —
// same scope as leave approvals (leaveUtils.js's leaveVisibilityWhere,
// BB-072): own department, or a direct report via EmploymentDetail.supervisorId,
// regardless of department. Admin/superadmin get the whole company.
const getMyTeam = async (req, res) => {
  try {
    const { companyId, id: actingUserId, role, departmentId } = req.user;
    if (!companyId) {
      return res.status(400).json({ error: "No company associated with the employee." });
    }

    const where = ["admin", "superadmin"].includes(role)
      ? { companyId }
      : {
          companyId,
          OR: [
            { employmentDetail: { supervisorId: actingUserId } },
            ...(departmentId ? [{ departmentId }] : []),
          ],
        };

    const employees = await prisma.user.findMany({
      where,
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        profile: {
          select: { firstName: true, lastName: true },
        },
        department: {
          select: { id: true, name: true },
        },
      },
      orderBy: { id: "asc" },
    });

    return res.status(200).json({ data: employees, message: "Team retrieved successfully." });
  } catch (error) {
    console.error("Error in getMyTeam:", error);
    return res.status(500).json({ error: "Internal server error." });
  }
};

const createEmployee = async (req, res) => {
  try {
    let { 
      email, username, password, role, firstName, lastName, phone, status, 
      departmentId, companyId, hireDate, employeeId,
      jobTitle, employmentStatus, exemptStatus, employmentType, 
      workLocation, probationEndDate, timeZone, workState, supervisorId
    } = req.body;
    
    if (!email || !password || !firstName || !lastName) {
      return res.status(400).json({ error: "Email, password, first name, and last name are required." });
    }

    const cleanedEmail = email.trim().toLowerCase();
    const cleanedEmployeeId = employeeId ? employeeId.trim() : null;

    const cleanedUsername = username
      ? username.trim().toLowerCase()
      : await generateUsername(firstName, lastName);

    const existingUsername = await prisma.user.findUnique({ where: { username: cleanedUsername } });
    if (existingUsername && username) return res.status(409).json({ error: "Username already exists." });
    
    const existingEmail = await prisma.user.findFirst({ 
      where: { email: cleanedEmail, companyId: req.user.companyId } 
    });
    if (existingEmail) return res.status(409).json({ error: "Employee already exists with this email in your company." });
    
    if (cleanedEmployeeId) {
      const existingEmployeeId = await prisma.user.findFirst({ 
        where: { employeeId: cleanedEmployeeId, companyId: req.user.companyId } 
      });
      if (existingEmployeeId) return res.status(409).json({ error: "Employee ID already exists in your company." });
    }

    const hashedPassword = bcrypt.hashSync(password, 10);
    let targetCompanyId = req.user.companyId;
    
    if (req.user.role === "superadmin" && companyId) {
      const companyExists = await prisma.company.findUnique({ where: { id: companyId } });
      if (!companyExists) return res.status(400).json({ error: "Invalid company ID provided." });
      targetCompanyId = companyId;
    }

    let parsedHireDate = null;
    if (hireDate) {
      parsedHireDate = new Date(hireDate);
      if (isNaN(parsedHireDate.getTime())) return res.status(400).json({ error: "Invalid hire date format." });
    }

    let parsedProbationEndDate = null;
    if (probationEndDate) {
      parsedProbationEndDate = new Date(probationEndDate);
      if (isNaN(parsedProbationEndDate.getTime())) return res.status(400).json({ error: "Invalid probation end date format." });
    }

    if (supervisorId) {
      const supervisorError = await validateSupervisorId({ supervisorId, companyId: targetCompanyId });
      if (supervisorError) return res.status(400).json({ error: supervisorError });
    }

    // Build employment detail data object
    const employmentDetailData = {};
    if (jobTitle) employmentDetailData.jobTitle = jobTitle.trim();
    if (employmentStatus) employmentDetailData.employmentStatus = employmentStatus;
    if (exemptStatus) employmentDetailData.exemptStatus = exemptStatus;
    if (employmentType) employmentDetailData.employmentType = employmentType;
    if (workLocation) employmentDetailData.workLocation = workLocation;
    if (parsedProbationEndDate) employmentDetailData.probationEndDate = parsedProbationEndDate;
    if (timeZone) employmentDetailData.timeZone = timeZone;
    if (workState) employmentDetailData.workState = workState;
    if (departmentId) employmentDetailData.departmentId = departmentId;
    if (supervisorId) employmentDetailData.supervisorId = supervisorId;

    const newEmployee = await prisma.user.create({
      data: {
        email: cleanedEmail,
        username: cleanedUsername,
        password: hashedPassword,
        role: role || "employee",
        status: status !== undefined ? status : "active",
        hireDate: parsedHireDate,
        employeeId: cleanedEmployeeId,
        company: { connect: { id: targetCompanyId } },
        ...(departmentId ? { department: { connect: { id: departmentId } } } : {}),
        profile: {
          create: {
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            phoneNumber: phone ? phone.trim() : null,
            username: cleanedUsername,
            email: cleanedEmail,
          },
        },
        ...(Object.keys(employmentDetailData).length > 0 ? {
          employmentDetail: {
            create: employmentDetailData
          }
        } : {}),
      },
      select: {
        id: true,
        email: true,
        username: true,
        role: true,
        status: true,
        hireDate: true,
        employeeId: true,
        createdAt: true,
        updatedAt: true,
        profile: { 
          select: { firstName: true, lastName: true, phoneNumber: true, username: true } 
        },
        company: { 
          select: { id: true, name: true } 
        },
        department: { 
          select: { id: true, name: true } 
        },
        employmentDetail: {
          select: {
            jobTitle: true,
            employmentStatus: true,
            exemptStatus: true,
            employmentType: true,
            workLocation: true,
            probationEndDate: true,
            timeZone: true,
            workState: true,
          }
        },
      },
    });
    
    // Send welcome email (non-blocking)
    try {
      const company = await prisma.company.findUnique({
        where: { id: targetCompanyId },
        select: { name: true },
      });
      const html = renderWelcome({
        firstName: firstName.trim(),
        companyName: company?.name || "BizBuddy",
        email: cleanedEmail,
        password,
      });
      await sendMail({
        to: cleanedEmail,
        subject: "Welcome to BizBuddy — your account is live",
        html,
        text: `Hi ${firstName.trim()}, your BizBuddy account is ready.\nEmail: ${cleanedEmail}\nPassword: ${password}`,
      });
      await prisma.emailNotificationLog.create({
        data: {
          notificationType: "WELCOME_EMAIL",
          subject: "Welcome to BizBuddy — your account is live",
          body: JSON.stringify({ firstName: firstName.trim(), companyName: company?.name || "BizBuddy" }),
          recipientEmail: cleanedEmail,
          recipientUserId: newEmployee.id,
          companyId: targetCompanyId,
          status: "sent",
        },
      });
      console.log(`[createEmployee] Welcome email sent to ${cleanedEmail}`);
    } catch (emailErr) {
      console.error("[createEmployee] Failed to send welcome email:", emailErr);
    }

    return res.status(201).json({ data: newEmployee, message: "Employee created successfully." });
  } catch (error) {
    console.error("Error in createEmployee:", error);
    return res.status(500).json({ error: "Internal server error." });
  }
};

const updateEmployee = async (req, res) => {
  try {
    const id = req.params.id;
    let { 
      email, password, role, firstName, lastName, phone, status, 
      companyId, departmentId, hireDate, employeeId,
      jobTitle, employmentStatus, exemptStatus, employmentType,
      workLocation, probationEndDate, timeZone, isDriver, supervisorId,
    } = req.body;

    const employee = await prisma.user.findFirst({
      where: { id, companyId: req.user.companyId },
      select: {
        id: true,
        email: true,
        username: true,
        role: true,
        status: true,
        hireDate: true,
        employeeId: true,
        companyId: true,
        profile: true,
        department: true,
      },
    });

    if (!employee) {
      return res.status(404).json({ error: "Employee not found or does not belong to your company." });
    }

    if (employee.id === req.user.id) {
      return res.status(400).json({ error: "You cannot update your own account." });
    }

    if (role && role.toLowerCase() === "superadmin" && req.user.role !== "superadmin") {
      return res.status(403).json({ error: "Cannot assign superadmin role." });
    }

    const requesterCompanyId = req.user.companyId;
    const cleanedEmail = email ? email.trim().toLowerCase() : employee.email;
    const cleanedEmployeeId = employeeId !== undefined ? (employeeId ? employeeId.trim() : null) : employee.employeeId;

    if (cleanedEmail !== employee.email) {
      const existingEmail = await prisma.user.findFirst({
        where: { email: cleanedEmail, companyId: requesterCompanyId, id: { not: id } },
      });
      if (existingEmail) {
        return res.status(409).json({ error: "Another employee in your company already uses this email." });
      }
    }

    if (cleanedEmployeeId !== employee.employeeId) {
      const employeeIdExists = await prisma.user.findFirst({
        where: { employeeId: cleanedEmployeeId, companyId: requesterCompanyId, id: { not: id } },
      });
      if (employeeIdExists) {
        return res.status(409).json({ error: "Another employee in your company already uses this employee ID." });
      }
    }

    const userData = {
      email: cleanedEmail,
      role: role || employee.role,
      status: status !== undefined ? status : employee.status,
      employeeId: cleanedEmployeeId,
      updatedAt: new Date(),
    };

    if (password) {
      userData.password = bcrypt.hashSync(password, 10);
    }

    if (hireDate !== undefined) {
      if (hireDate === null) {
        userData.hireDate = null;
      } else if (hireDate) {
        const parsedHireDate = new Date(hireDate);
        if (isNaN(parsedHireDate.getTime())) {
          return res.status(400).json({ error: "Invalid hire date format." });
        }
        userData.hireDate = parsedHireDate;
      }
    }

    if (departmentId !== undefined) {
      if (departmentId && departmentId !== "none") {
        const deptExists = await prisma.department.findUnique({ where: { id: departmentId } });
        if (!deptExists) {
          return res.status(400).json({ error: "Invalid department ID." });
        }
        userData.department = { connect: { id: departmentId } };
      } else {
        userData.department = { disconnect: true };
      }
    }

    let targetCompanyId = employee.companyId;
    if (req.user.role === "superadmin" && companyId) {
      const companyExists = await prisma.company.findUnique({ where: { id: companyId } });
      if (!companyExists) {
        return res.status(400).json({ error: "Invalid company ID provided." });
      }
      targetCompanyId = companyId;
      userData.company = { connect: { id: companyId } };
    }

    const profileData = {};
    if (firstName) profileData.firstName = firstName.trim();
    if (lastName) profileData.lastName = lastName.trim();
    if (phone !== undefined) profileData.phoneNumber = phone ? phone.trim() : null;

    // Build employment detail data
    const employmentDetailData = {};
    if (jobTitle !== undefined) employmentDetailData.jobTitle = jobTitle ? jobTitle.trim() : null;
    if (employmentStatus !== undefined && employmentStatus !== 'none') {
      employmentDetailData.employmentStatus = employmentStatus;
    }
    if (exemptStatus !== undefined && exemptStatus !== 'none') {
      employmentDetailData.exemptStatus = exemptStatus;
    }
    if (employmentType !== undefined && employmentType !== 'none') {
      employmentDetailData.employmentType = employmentType;
    }
    if (workLocation !== undefined && workLocation !== 'none') {
      employmentDetailData.workLocation = workLocation;
    }
    if (probationEndDate !== undefined) {
      if (probationEndDate === null || probationEndDate === '') {
        employmentDetailData.probationEndDate = null;
      } else {
        const parsedDate = new Date(probationEndDate);
        if (!isNaN(parsedDate.getTime())) {
          employmentDetailData.probationEndDate = parsedDate;
        }
      }
    }
    if (timeZone !== undefined) {
      employmentDetailData.timeZone = timeZone ? timeZone.trim() : null;
    }
    if (typeof isDriver === "boolean") {
      employmentDetailData.isDriver = isDriver;
    }
    if (supervisorId !== undefined) {
      // BB-055: supervisor assignment is edit-only — it must not silently create
      // a bare EmploymentDetail row for an employee who doesn't have one yet.
      const existingDetail = await prisma.employmentDetail.findUnique({
        where: { userId: id },
        select: { id: true },
      });

      if (!supervisorId || supervisorId === 'none') {
        if (existingDetail) employmentDetailData.supervisorId = null;
      } else if (!existingDetail) {
        return res.status(400).json({
          error: "Set up this employee's employment details before assigning a supervisor.",
        });
      } else {
        const supervisorError = await validateSupervisorId({
          supervisorId,
          companyId: targetCompanyId,
          targetUserId: id,
        });
        if (supervisorError) return res.status(400).json({ error: supervisorError });
        employmentDetailData.supervisorId = supervisorId;
      }
    }

    const updatedEmployee = await prisma.user.update({
      where: { id },
      data: {
        ...userData,
        profile: Object.keys(profileData).length
          ? {
              update: {
                ...profileData,
                email: cleanedEmail,
                username: userData.username || employee.username,
              },
            }
          : undefined,
        employmentDetail: Object.keys(employmentDetailData).length
          ? {
            upsert: {
              create: employmentDetailData,
              update: employmentDetailData,
            },
          }
          : undefined,
      },
      select: {
        id: true,
        email: true,
        username: true,
        role: true,
        status: true,
        hireDate: true,
        employeeId: true,
        createdAt: true,
        updatedAt: true,
        profile: { select: { firstName: true, lastName: true, phoneNumber: true, username: true } },
        company: { select: { id: true, name: true } },
        department: { select: { id: true, name: true } },
        employmentDetail: {
          include: {
            supervisor: {
              select: { id: true, email: true, profile: { select: { firstName: true, lastName: true } } },
            },
          },
        },
      },
    });

    return res.status(200).json({ data: updatedEmployee, message: "Employee updated successfully." });
  } catch (error) {
    console.error("Error in updateEmployee:", error);
    return res.status(500).json({ error: "Internal server error." });
  }
};

const deleteEmployee = async (req, res) => {
  try {
    const id = req.params.id;
    const requesterCompanyId = req.user.companyId;
    if (!requesterCompanyId) {
      return res.status(400).json({ error: "No company associated with the employee." });
    }
    const employee = await prisma.user.findFirst({
      where: { id, companyId: requesterCompanyId },
    });
    if (!employee) {
      return res.status(404).json({ error: "Employee not found or does not belong to your company." });
    }
    if (employee.id === req.user.id) {
      return res.status(400).json({ error: "You cannot delete your own account." });
    }
    await prisma.userShift.deleteMany({ where: { userId: id } });
    await prisma.locationRestriction.deleteMany({ where: { userId: id } });
    await prisma.userActivity.deleteMany({ where: { userId: id } });
    await prisma.cutoffOtBlock.updateMany({ where: { approvedBy: id }, data: { approvedBy: null } });
    await prisma.cutoffOtBlock.deleteMany({ where: { userId: id } });
    await prisma.user.delete({ where: { id } });
    return res.status(200).json({ message: "Employee deleted successfully." });
  } catch (error) {
    console.error("Error in deleteEmployee:", error);
    return res.status(500).json({ error: "Internal server error." });
  }
};

const updateEmployeePresence = async (req, res) => {
  try {
    const employee = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        email: true,
        username: true,
        role: true,
        status: true,
      },
    });
    return res.status(200).json({
      data: employee,
      message: "Employee presence update is not implemented in schema.",
    });
  } catch (error) {
    console.error("Error in updateEmployeePresence:", error);
    return res.status(500).json({ error: "Internal server error." });
  }
};

const changeEmployeePassword = async (req, res) => {
  try {
    const { oldPassword, newPassword, confirmPassword } = req.body;
    if (!oldPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({ error: "All password fields are required." });
    }
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ error: "New password and confirmation do not match." });
    }
    const employee = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!employee) {
      return res.status(404).json({ error: "Employee not found." });
    }
    const isMatch = bcrypt.compareSync(oldPassword, employee.password);
    if (!isMatch) {
      return res.status(400).json({ error: "Old password is incorrect." });
    }
    await prisma.user.update({
      where: { id: req.user.id },
      data: { password: bcrypt.hashSync(newPassword, 10) },
    });
    return res.status(200).json({ message: "Employee password changed successfully." });
  } catch (error) {
    console.error("Error in changeEmployeePassword:", error);
    return res.status(500).json({ error: "Internal server error." });
  }
};

const getEmployeeById = async (req, res) => {
  try {
    const id = req.params.id;
    const employee = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        username: true,
        role: true,
        status: true,
        hireDate: true,
        employeeId: true,
        companyId: true,
        createdAt: true,
        updatedAt: true,
        profile: {
          select: {
            firstName: true,
            lastName: true,
            phoneNumber: true,
            username: true,
            dateOfBirth: true,
            ssnItin: true,
            addressLine: true,
            city: true,
            state: true,
            postalCode: true,
            emergencyContactName: true,
            emergencyContactPhone: true,
          },
        },
        department: {
          select: { 
            id: true, 
            name: true,
            supervisor: {  
              select: {
                id: true,
                email: true,
                profile: {
                  select: {
                    firstName: true,
                    lastName: true
                  }
                }
              }
            }
          },
        },
        company: {
          select: { id: true, name: true },
        },
        employmentDetail: {
          select: {
            jobTitle: true,
            employmentStatus: true,
            exemptStatus: true,
            employmentType: true,
            workLocation: true,
            probationEndDate: true,
            timeZone: true,
            workState: true,
            supervisor: {
              select: { 
                id: true, 
                email: true,
                profile: {
                  select: {
                    firstName: true,
                    lastName: true
                  }
                }
              },
            },
          },
        },
      },
    });
    
    if (!employee) {
      return res.status(404).json({ error: "Employee not found." });
    }
    
    if (req.user.role !== "superadmin" && employee.companyId !== req.user.companyId) {
      return res.status(403).json({ error: "Unauthorized request." });
    }
    
    return res.status(200).json({ data: employee, message: "Employee retrieved successfully." });
  } catch (error) {
    console.error("Error in getEmployeeById:", error);
    return res.status(500).json({ error: "Internal server error." });
  }
};

const bulkCreateEmployees = async (req, res) => {
  try {
    const { employees } = req.body;

    if (!Array.isArray(employees) || employees.length === 0) {
      return res.status(400).json({ error: "employees must be a non-empty array." });
    }

    if (employees.length > 100) {
      return res.status(400).json({ error: "Maximum 100 employees per bulk request." });
    }

    const targetCompanyId = req.user.companyId;

    // Fetch company name once for the welcome email
    const company = await prisma.company.findUnique({
      where: { id: targetCompanyId },
      select: { name: true },
    });
    const companyName = company?.name || "BizBuddy";

    const created = [];
    const failed = [];

    for (let i = 0; i < employees.length; i++) {
      const emp = employees[i];
      const index = i;

      try {
        const {
          email, username, password, role, firstName, lastName, phone, status,
          departmentId, hireDate, employeeId,
          jobTitle, employmentStatus, exemptStatus, employmentType,
          workLocation, probationEndDate, timeZone, workState, supervisorId,
        } = emp;

        if (!email || !password || !firstName || !lastName) {
          failed.push({ index, email: email || null, reason: "Missing required fields: email, password, firstName, lastName" });
          continue;
        }

        const cleanedEmail = email.trim().toLowerCase();
        const cleanedEmployeeId = employeeId ? employeeId.trim() : null;

        const cleanedUsername = username
          ? username.trim().toLowerCase()
          : await generateUsername(firstName, lastName);

        // Only reject duplicate username if it was explicitly provided
        if (username) {
          const existingUsername = await prisma.user.findUnique({ where: { username: cleanedUsername } });
          if (existingUsername) {
            failed.push({ index, email: cleanedEmail, reason: "Username already exists." });
            continue;
          }
        }

        const existingEmail = await prisma.user.findFirst({
          where: { email: cleanedEmail, companyId: targetCompanyId },
        });
        if (existingEmail) {
          failed.push({ index, email: cleanedEmail, reason: "Email already exists in this company." });
          continue;
        }

        if (cleanedEmployeeId) {
          const existingEmpId = await prisma.user.findFirst({
            where: { employeeId: cleanedEmployeeId, companyId: targetCompanyId },
          });
          if (existingEmpId) {
            failed.push({ index, email: cleanedEmail, reason: "Employee ID already exists in this company." });
            continue;
          }
        }

        const hashedPassword = bcrypt.hashSync(password, 10);

        let parsedHireDate = null;
        if (hireDate) {
          parsedHireDate = new Date(hireDate);
          if (isNaN(parsedHireDate.getTime())) {
            failed.push({ index, email: cleanedEmail, reason: "Invalid hire date format." });
            continue;
          }
        }

        let parsedProbationEndDate = null;
        if (probationEndDate) {
          parsedProbationEndDate = new Date(probationEndDate);
          if (isNaN(parsedProbationEndDate.getTime())) {
            failed.push({ index, email: cleanedEmail, reason: "Invalid probation end date format." });
            continue;
          }
        }

        if (supervisorId) {
          const supervisorError = await validateSupervisorId({ supervisorId, companyId: targetCompanyId });
          if (supervisorError) {
            failed.push({ index, email: cleanedEmail, reason: supervisorError });
            continue;
          }
        }

        const employmentDetailData = {};
        if (jobTitle) employmentDetailData.jobTitle = jobTitle.trim();
        if (employmentStatus) employmentDetailData.employmentStatus = employmentStatus;
        if (exemptStatus) employmentDetailData.exemptStatus = exemptStatus;
        if (employmentType) employmentDetailData.employmentType = employmentType;
        if (workLocation) employmentDetailData.workLocation = workLocation;
        if (parsedProbationEndDate) employmentDetailData.probationEndDate = parsedProbationEndDate;
        if (timeZone) employmentDetailData.timeZone = timeZone;
        if (workState) employmentDetailData.workState = workState;
        if (departmentId) employmentDetailData.departmentId = departmentId;
        if (supervisorId) employmentDetailData.supervisorId = supervisorId;

        const newEmployee = await prisma.user.create({
          data: {
            email: cleanedEmail,
            username: cleanedUsername,
            password: hashedPassword,
            role: role || "employee",
            status: status !== undefined ? status : "active",
            hireDate: parsedHireDate,
            employeeId: cleanedEmployeeId,
            company: { connect: { id: targetCompanyId } },
            ...(departmentId ? { department: { connect: { id: departmentId } } } : {}),
            profile: {
              create: {
                firstName: firstName.trim(),
                lastName: lastName.trim(),
                phoneNumber: phone ? phone.trim() : null,
                username: cleanedUsername,
                email: cleanedEmail,
              },
            },
            ...(Object.keys(employmentDetailData).length > 0 ? {
              employmentDetail: { create: employmentDetailData },
            } : {}),
          },
          select: {
            id: true,
            email: true,
            username: true,
            role: true,
            status: true,
            hireDate: true,
            employeeId: true,
            profile: { select: { firstName: true, lastName: true } },
          },
        });

        created.push(newEmployee);

        // Send credentials email (non-blocking)
        try {
          const html = renderWelcome({
            firstName: firstName.trim(),
            companyName,
            email: cleanedEmail,
            password,
          });
          await sendMail({
            to: cleanedEmail,
            subject: "Welcome to BizBuddy — your account is ready",
            html,
            text: `Hi ${firstName.trim()}, your BizBuddy account has been created.\nEmail: ${cleanedEmail}\nPassword: ${password}`,
          });
          await prisma.emailNotificationLog.create({
            data: {
              notificationType: "WELCOME_EMAIL",
              recipientEmail: cleanedEmail,
              recipientUserId: newEmployee.id,
              companyId: targetCompanyId,
              subject: "Welcome to BizBuddy — your account is ready",
              body: JSON.stringify({ firstName: firstName.trim(), companyName }),
              status: "sent",
            },
          });

          console.log(`[bulkCreateEmployees] Welcome email sent to ${cleanedEmail}`);
        } catch (emailErr) {
          console.error(`[bulkCreateEmployees] Failed to send email to ${cleanedEmail}:`, emailErr);

          try {
            await prisma.emailNotificationLog.create({
              data: {
                notificationType: "WELCOME_EMAIL",
                recipientEmail: cleanedEmail,
                recipientUserId: newEmployee.id,
                companyId: targetCompanyId,
                subject: "Welcome to BizBuddy — your account is ready",
                body: JSON.stringify({ firstName: firstName.trim(), companyName }),
                status: "failed",
                errorMessage: emailErr.message,
              },
            });
          } catch (_) {}
        }
      } catch (empErr) {
        console.error(`[bulkCreateEmployees] Error at index ${index}:`, empErr);
        failed.push({ index, email: emp.email || null, reason: empErr.message });
      }
    }

    return res.status(207).json({
      message: `Bulk creation complete. ${created.length} created, ${failed.length} failed.`,
      data: { created, failed },
    });
  } catch (error) {
    console.error("Error in bulkCreateEmployees:", error);
    return res.status(500).json({ error: "Internal server error." });
  }
};

module.exports = {
  getAllEmployees,
  getMyTeam,
  createEmployee,
  updateEmployee,
  deleteEmployee,
  updateEmployeePresence,
  changeEmployeePassword,
  getEmployeeById,
  bulkCreateEmployees,
};
