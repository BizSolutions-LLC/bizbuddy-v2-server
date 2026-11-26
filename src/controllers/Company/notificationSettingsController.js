const { prisma } = require('@config/connection');
const { recordDiff } = require('@services/Company/companySettingsEventService'); // BB-151

/**
 * Get company notification settings
 */
const getSettingsNotification = async (req, res) => {
  console.log("getSettings")
  try {
    const { companyId } = req.user;

    console.log('🔍 Fetching notification settings for companyId:', companyId);

    if (!companyId) {
      return res.status(400).json({
        success: false,
        message: 'Company ID not found in user session',
      });
    }

    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: {
        clockInGracePeriod: true,
        clockOutGracePeriod: true,
        notifyEmployeeMissedIn: true,
        notifyEmployeeMissedOut: true,
        notifyAdminMissedClocks: true,
        morningReportTime: true,
        eveningReportTime: true,
      },
    });

    if (!company) {
      console.error('❌ Company not found:', companyId);
      return res.status(404).json({
        success: false,
        message: 'Company not found',
      });
    }

    console.log('✅ Notification settings found:', company);

    // Return settings with defaults if null
    return res.status(200).json({
      success: true,
      data: {
        clockInGracePeriod: company.clockInGracePeriod ?? 30,
        clockOutGracePeriod: company.clockOutGracePeriod ?? 30,
        notifyEmployeeMissedIn: company.notifyEmployeeMissedIn ?? true,
        notifyEmployeeMissedOut: company.notifyEmployeeMissedOut ?? true,
        notifyAdminMissedClocks: company.notifyAdminMissedClocks ?? true,
        morningReportTime: company.morningReportTime ?? '10:00',
        eveningReportTime: company.eveningReportTime ?? '18:00',
      },
    });
  } catch (error) {
    console.error('❌ Error fetching notification settings:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch notification settings',
      error: error.message,
    });
  }
};

// BB-151: the fields the notification settings page writes (history snapshot).
const NOTIFICATION_SELECT = {
  clockInGracePeriod: true,
  clockOutGracePeriod: true,
  notifyEmployeeMissedIn: true,
  notifyEmployeeMissedOut: true,
  notifyAdminMissedClocks: true,
  morningReportTime: true,
  eveningReportTime: true,
};

/**
 * Update company notification settings
 */
const updateSettingsNotification = async (req, res) => {
  console.log("updateSettings")
  try {
    const { companyId } = req.user;
    const {
      clockInGracePeriod,
      clockOutGracePeriod,
      notifyEmployeeMissedIn,
      notifyEmployeeMissedOut,
      notifyAdminMissedClocks,
      morningReportTime,
      eveningReportTime,
    } = req.body;

    console.log('💾 Updating notification settings for companyId:', companyId);
    console.log('📝 New settings:', req.body);

    if (!companyId) {
      return res.status(400).json({
        success: false,
        message: 'Company ID not found in user session',
      });
    }

    // Validate grace periods (0-120 minutes)
    if (clockInGracePeriod < 0 || clockInGracePeriod > 120) {
      return res.status(400).json({
        success: false,
        message: 'Clock-in grace period must be between 0 and 120 minutes',
      });
    }

    if (clockOutGracePeriod < 0 || clockOutGracePeriod > 120) {
      return res.status(400).json({
        success: false,
        message: 'Clock-out grace period must be between 0 and 120 minutes',
      });
    }

    // Validate time format (HH:MM)
    const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
    if (!timeRegex.test(morningReportTime) || !timeRegex.test(eveningReportTime)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid time format. Use HH:MM format (e.g., 10:00)',
      });
    }

    // BB-151: snapshot for the settings history.
    const before = await prisma.company.findUnique({ where: { id: companyId }, select: NOTIFICATION_SELECT });

    const updated = await prisma.company.update({
      where: { id: companyId },
      select: NOTIFICATION_SELECT,
      data: {
        clockInGracePeriod: parseInt(clockInGracePeriod),
        clockOutGracePeriod: parseInt(clockOutGracePeriod),
        notifyEmployeeMissedIn,
        notifyEmployeeMissedOut,
        notifyAdminMissedClocks,
        morningReportTime,
        eveningReportTime,
      },
    });

    await recordDiff({ req, companyId, area: "notifications", before, after: updated });

    console.log('✅ Notification settings updated successfully');

    return res.status(200).json({
      success: true,
      message: 'Notification settings updated successfully',
      data: {
        clockInGracePeriod: updated.clockInGracePeriod,
        clockOutGracePeriod: updated.clockOutGracePeriod,
        notifyEmployeeMissedIn: updated.notifyEmployeeMissedIn,
        notifyEmployeeMissedOut: updated.notifyEmployeeMissedOut,
        notifyAdminMissedClocks: updated.notifyAdminMissedClocks,
        morningReportTime: updated.morningReportTime,
        eveningReportTime: updated.eveningReportTime,
      },
    });
  } catch (error) {
    console.error('❌ Error updating notification settings:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update notification settings',
      error: error.message,
    });
  }
};

// ✅ Export at the bottom
module.exports = {
  getSettingsNotification,
  updateSettingsNotification,
};