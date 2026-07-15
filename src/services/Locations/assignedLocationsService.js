// src/services/Locations/assignedLocationsService.js
const { prisma } = require("@config/connection");

async function getAssignedLocations(userId) {
  const restrictions = await prisma.locationRestriction.findMany({
    where: { userId, restrictionStatus: true },
    include: { location: true },
  });

  return restrictions.map((r) => ({
    id: r.location.id,
    name: r.location.name,
    latitude: r.location.latitude,
    longitude: r.location.longitude,
    radius: r.location.radius,
  }));
}

module.exports = { getAssignedLocations };
