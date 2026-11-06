// Display names for IFC entity types. STEP files write types in upper case; these restore the
// schema's spelling for the types an importer meets most.

const NAMES = [
  'IfcProject', 'IfcSite', 'IfcBuilding', 'IfcBuildingStorey', 'IfcSpace', 'IfcZone', 'IfcFacility', 'IfcFacilityPart',
  'IfcBridge', 'IfcBridgePart', 'IfcRoad', 'IfcRoadPart', 'IfcRailway', 'IfcRailwayPart', 'IfcMarineFacility', 'IfcMarinePart',
  'IfcAlignment', 'IfcExternalSpatialElement', 'IfcSpatialZone',
  'IfcWall', 'IfcWallStandardCase', 'IfcWallElementedCase', 'IfcCurtainWall', 'IfcSlab', 'IfcSlabStandardCase', 'IfcSlabElementedCase',
  'IfcRoof', 'IfcBeam', 'IfcBeamStandardCase', 'IfcColumn', 'IfcColumnStandardCase', 'IfcMember', 'IfcMemberStandardCase',
  'IfcPlate', 'IfcPlateStandardCase', 'IfcDoor', 'IfcDoorStandardCase', 'IfcWindow', 'IfcWindowStandardCase', 'IfcStair',
  'IfcStairFlight', 'IfcRamp', 'IfcRampFlight', 'IfcRailing', 'IfcCovering', 'IfcFooting', 'IfcPile', 'IfcChimney', 'IfcShadingDevice',
  'IfcBuildingElementProxy', 'IfcBuildingElementPart', 'IfcBuildingElementComponent', 'IfcElementAssembly', 'IfcFurnishingElement',
  'IfcFurniture', 'IfcSystemFurnitureElement', 'IfcOpeningElement', 'IfcOpeningStandardCase', 'IfcVoidingFeature', 'IfcSurfaceFeature',
  'IfcProjectionElement', 'IfcDiscreteAccessory', 'IfcFastener', 'IfcMechanicalFastener', 'IfcReinforcingBar', 'IfcReinforcingMesh',
  'IfcTendon', 'IfcTendonAnchor', 'IfcGeographicElement', 'IfcCivilElement', 'IfcTransportElement', 'IfcVirtualElement', 'IfcAnnotation',
  'IfcGrid', 'IfcProxy', 'IfcCourse', 'IfcPavement', 'IfcKerb', 'IfcRail', 'IfcTrackElement', 'IfcEarthworksFill', 'IfcEarthworksCut',
  'IfcBearing', 'IfcDeepFoundation', 'IfcCaissonFoundation', 'IfcSign', 'IfcSignal', 'IfcBorehole', 'IfcGeomodel', 'IfcGeoslice',
  'IfcDistributionElement', 'IfcDistributionFlowElement', 'IfcDistributionControlElement', 'IfcDistributionChamberElement', 'IfcFlowSegment', 'IfcFlowFitting',
  'IfcFlowTerminal', 'IfcFlowController', 'IfcFlowMovingDevice', 'IfcFlowStorageDevice', 'IfcFlowTreatmentDevice', 'IfcEnergyConversionDevice',
  'IfcPipeSegment', 'IfcPipeFitting', 'IfcDuctSegment', 'IfcDuctFitting', 'IfcCableSegment', 'IfcCableCarrierSegment', 'IfcCableFitting',
  'IfcCableCarrierFitting', 'IfcAirTerminal', 'IfcSanitaryTerminal', 'IfcLightFixture', 'IfcLamp', 'IfcOutlet', 'IfcSwitchingDevice',
  'IfcValve', 'IfcPump', 'IfcFan', 'IfcBoiler', 'IfcChiller', 'IfcTank', 'IfcSpaceHeater', 'IfcUnitaryEquipment', 'IfcElectricAppliance',
  'IfcFireSuppressionTerminal', 'IfcWasteTerminal', 'IfcStackTerminal', 'IfcCommunicationsAppliance', 'IfcAudioVisualAppliance',
  'IfcSensor', 'IfcActuator', 'IfcAlarm', 'IfcController', 'IfcFlowInstrument', 'IfcProtectiveDevice', 'IfcJunctionBox',
  'IfcElectricDistributionBoard', 'IfcElectricMotor', 'IfcTransformer', 'IfcMedicalDevice', 'IfcInterceptor', 'IfcDamper',
  'IfcFilter', 'IfcCoil', 'IfcCompressor', 'IfcCondenser', 'IfcCoolingTower', 'IfcEvaporator', 'IfcHeatExchanger', 'IfcHumidifier',
  'IfcBurner', 'IfcEngine', 'IfcSolarDevice', 'IfcElectricGenerator', 'IfcElectricFlowStorageDevice', 'IfcMobileTelecommunicationsAppliance',
  'IfcDistributionPort', 'IfcPort', 'IfcElement', 'IfcBuildingElement', 'IfcBuiltElement', 'IfcElementComponent', 'IfcProduct',
];

const byUpper = new Map(NAMES.map(name => [name.toUpperCase(), name]));

/** The schema spelling of a type, such as IfcWallStandardCase for IFCWALLSTANDARDCASE. */
export function typeName(upper: string): string {
  return byUpper.get(upper) ?? (upper.startsWith('IFC') ? `Ifc${upper.slice(3).charAt(0)}${upper.slice(4).toLowerCase()}` : upper);
}
