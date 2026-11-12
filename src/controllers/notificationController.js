const { prisma } = require('@config/connection');
const { targetRouteFor } = require('@services/notificationTargets');

// BB-117: deleting hides a notification (deletedAt) instead of erasing it, so its
// duplicate-check key keeps working and it isn't sent again. Hidden rows are never
// returned; the nightly retention job removes them for good after 30 days.
// Responses keep their shape, plus `targetRoute` (the app screen a tap opens;
// older rows get the default for their type). Internal fields are not sent.
const VISIBLE = { deletedAt: null };
function toClient(n) {
  if (!n) return n;
  const { dedupeKey, deletedAt, ...rest } = n;
  return { ...rest, targetRoute: n.targetRoute || targetRouteFor(n.notificationCode) };
}

/**
 * Get user's notifications (paginated)
 */
exports.getNotifications = async (req, res) => {
  try {
    const { id: userId } = req.user;
    const { page = 1, limit = 20, seen } = req.query;

    const skip = (page - 1) * limit;
    const where = { userId, ...VISIBLE };

    if (seen !== undefined) {
      where.seen = seen === 'true';
    }

    const [notifications, total] = await Promise.all([
      prisma.notificationLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: parseInt(skip),
        take: parseInt(limit),
      }),
      prisma.notificationLog.count({ where }),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        notifications: notifications.map(toClient),
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
    });
  } catch (error) {
    console.error('❌ Error fetching notifications:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch notifications',
    });
  }
};

/**
 * Get unread notification count
 */
exports.getUnreadCount = async (req, res) => {
  try {
    const { id: userId } = req.user;

    const count = await prisma.notificationLog.count({
      where: {
        userId,
        seen: false,
        ...VISIBLE,
      },
    });

    return res.status(200).json({
      success: true,
      data: { count },
    });
  } catch (error) {
    console.error('❌ Error getting unread count:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to get unread count',
    });
  }
};

/**
 * Mark notification as seen
 */
exports.markAsSeen = async (req, res) => {
  try {
    const { id: userId } = req.user;
    const { id: notificationId } = req.params;

    const notification = await prisma.notificationLog.findFirst({
      where: {
        id: notificationId,
        userId,
        ...VISIBLE,
      },
    });

    if (!notification) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found',
      });
    }

    const updated = await prisma.notificationLog.update({
      where: { id: notificationId },
      data: {
        seen: true,
        seenAt: new Date(),
      },
    });

    return res.status(200).json({
      success: true,
      data: toClient(updated),
    });
  } catch (error) {
    console.error('❌ Error marking notification as seen:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to mark notification as seen',
    });
  }
};

/**
 * Mark all notifications as seen
 */
exports.markAllAsSeen = async (req, res) => {
  try {
    const { id: userId } = req.user;

    const result = await prisma.notificationLog.updateMany({
      where: {
        userId,
        seen: false,
        ...VISIBLE,
      },
      data: {
        seen: true,
        seenAt: new Date(),
      },
    });

    return res.status(200).json({
      success: true,
      message: `${result.count} notifications marked as seen`,
      data: { count: result.count },
    });
  } catch (error) {
    console.error('❌ Error marking all as seen:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to mark all notifications as seen',
    });
  }
};

/**
 * Delete notification
 */
exports.deleteNotification = async (req, res) => {
  try {
    const { id: userId } = req.user;
    const { id: notificationId } = req.params;

    const notification = await prisma.notificationLog.findFirst({
      where: {
        id: notificationId,
        userId,
        ...VISIBLE,
      },
    });

    if (!notification) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found',
      });
    }

    await prisma.notificationLog.update({
      where: { id: notificationId },
      data: { deletedAt: new Date() },
    });

    return res.status(200).json({
      success: true,
      message: 'Notification deleted',
    });
  } catch (error) {
    console.error('❌ Error deleting notification:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete notification',
    });
  }
};

/**
 * Clear all notifications
 */
exports.clearAllNotifications = async (req, res) => {
  try {
    const { id: userId } = req.user;

    const result = await prisma.notificationLog.updateMany({
      where: { userId, ...VISIBLE },
      data: { deletedAt: new Date() },
    });

    return res.status(200).json({
      success: true,
      message: `${result.count} notifications cleared`,
      data: { count: result.count },
    });
  } catch (error) {
    console.error('❌ Error clearing notifications:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to clear notifications',
    });
  }
};