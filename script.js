/*********************************
 MAPBOX TOKEN
*********************************/
mapboxgl.accessToken = 'pk.eyJ1IjoiaHVtYW5lODYiLCJhIjoiY21raXRneTM4MHRqbTNlcXlmb3JjZWtoeiJ9.3vFK4WlsEXgCvGHwdFFzyw';

/*********************************
 MAP INITIALIZATION
*********************************/
const campusCenter = [3.9470, 7.3775];

const map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/mapbox/light-v11',
  center: campusCenter,
  zoom: 17,
  pitch: 60,
  bearing: -20,
  antialias: true
});

map.addControl(new mapboxgl.NavigationControl(), 'bottom-right');

/*********************************
 GLOBAL VARIABLES
*********************************/
let userLocation = campusCenter;
let previousUserLocation = null;
let userMarker = null;

let buildingsData = null;
let officesData = null;
let accessPointsData = null;
let campusNetworkData = null;

let selectedBuildingId = null;
let is3DEnabled = true;

let graph = {};
let graphNodes = [];

let currentDestination = null;
let currentDestinationName = null;
let currentRouteCoords = [];
let currentMode = 'walking';

let navigationActive = false;
let watchId = null;

let maneuvers = [];
let announcedManeuverIndex = -1;
let lastUserLocation = null;

/*********************************
 BASIC HELPERS
*********************************/
function coordKey(coord) {
  return `${coord[0].toFixed(6)},${coord[1].toFixed(6)}`;
}

function haversineDistance(a, b) {
  const toRad = deg => (deg * Math.PI) / 180;

  const lon1 = a[0], lat1 = a[1];
  const lon2 = b[0], lat2 = b[1];

  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLon / 2);

  const aa =
    s1 * s1 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * s2 * s2;

  const c = 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa));
  return R * c;
}

function formatDistance(meters) {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(2)} km`;
}

function estimateTime(distanceMeters, mode) {
  const speed = mode === 'walking' ? 1.4 : 5.5;
  const seconds = distanceMeters / speed;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} min`;
}

function calculatePathDistance(pathCoords) {
  let total = 0;
  for (let i = 0; i < pathCoords.length - 1; i++) {
    total += haversineDistance(pathCoords[i], pathCoords[i + 1]);
  }
  return total;
}

function hasMovedEnough(newLoc) {
  if (!lastUserLocation) {
    lastUserLocation = newLoc;
    return true;
  }

  const dist = haversineDistance(lastUserLocation, newLoc);

  if (dist > 5) {
    lastUserLocation = newLoc;
    return true;
  }

  return false;
}

/*********************************
 GEOMETRY HELPERS
*********************************/
function getFeatureCenter(feature) {
  if (!feature || !feature.geometry) return null;

  const geomType = feature.geometry.type;

  if (geomType === 'Point') {
    return feature.geometry.coordinates;
  }

  const bounds = new mapboxgl.LngLatBounds();
  let coords = [];

  if (geomType === 'Polygon') {
    coords = feature.geometry.coordinates[0];
  } else if (geomType === 'MultiPolygon') {
    coords = feature.geometry.coordinates[0][0];
  } else {
    return null;
  }

  coords.forEach(coord => bounds.extend(coord));
  return bounds.getCenter().toArray();
}

/*********************************
 ACCESS POINT HELPERS
*********************************/
function getAccessPointByBuildingId(buildingId) {
  if (!accessPointsData || !accessPointsData.features) return null;

  const feature = accessPointsData.features.find(f =>
    f.properties &&
    Number(f.properties.building_id) === Number(buildingId)
  );

  return feature ? feature.geometry.coordinates : null;
}

/*********************************
 UI PANEL HELPERS
*********************************/
function updateNavPanel({
  destination = '-',
  mode = '-',
  distance = '-',
  eta = '-',
  status = 'Idle'
}) {
  const destinationEl = document.getElementById('navDestination');
  const modeEl = document.getElementById('navMode');
  const distanceEl = document.getElementById('navDistance');
  const etaEl = document.getElementById('navEta');
  const statusEl = document.getElementById('navStatus');

  if (destinationEl) destinationEl.innerText = destination;
  if (modeEl) modeEl.innerText = mode;
  if (distanceEl) distanceEl.innerText = distance;
  if (etaEl) etaEl.innerText = eta;
  if (statusEl) statusEl.innerText = status;
}

function clearSuggestions() {
  const suggestionBox = document.getElementById('suggestions');
  if (suggestionBox) suggestionBox.innerHTML = '';
}

function recenterOnUser() {
  if (!userLocation) return;

  map.easeTo({
    center: userLocation,
    zoom: 18,
    pitch: is3DEnabled ? 60 : 0,
    duration: 800
  });
}

/*********************************
 BUILDING HIGHLIGHT + LABEL
*********************************/
function update3DBuildingStyle() {
  if (!map.getLayer('3d-buildings')) return;

  map.setPaintProperty('3d-buildings', 'fill-extrusion-color', [
    'case',
    ['==', ['get', 'id'], selectedBuildingId],
    '#ff3333',
    '#cfcfcf'
  ]);

  map.setPaintProperty('3d-buildings', 'fill-extrusion-height', [
    'case',
    ['==', ['get', 'id'], selectedBuildingId],
    ['+', ['coalesce', ['get', 'Building_Height(m)'], 6], 4],
    ['coalesce', ['get', 'Building_Height(m)'], 6]
  ]);
}

function highlightBuilding(buildingId) {
  selectedBuildingId = Number(buildingId);
  update3DBuildingStyle();
}

function showSelectedBuildingLabel(feature) {
  if (!feature) return;

  const center = getFeatureCenter(feature);
  if (!center) return;

  const labelFeature = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {
          Name: feature.properties?.Name || 'Selected Building'
        },
        geometry: {
          type: 'Point',
          coordinates: center
        }
      }
    ]
  };

  if (map.getSource('selected-building-label')) {
    map.getSource('selected-building-label').setData(labelFeature);
  } else {
    map.addSource('selected-building-label', {
      type: 'geojson',
      data: labelFeature
    });

    map.addLayer({
      id: 'selected-building-label-layer',
      type: 'symbol',
      source: 'selected-building-label',
      layout: {
        'text-field': ['get', 'Name'],
        'text-size': 14,
        'text-offset': [0, -1.5],
        'text-anchor': 'top'
      },
      paint: {
        'text-color': '#111111',
        'text-halo-color': '#ffffff',
        'text-halo-width': 2
      }
    });
  }
}

/*********************************
 NETWORK GRAPH
*********************************/
function buildGraphFromNetwork(mode = 'walking') {
  graph = {};
  graphNodes = [];

  if (!campusNetworkData || !campusNetworkData.features) return;

  campusNetworkData.features.forEach(feature => {
    const props = feature.properties || {};
    const geometry = feature.geometry;

    if (!geometry) return;

    const allowed =
      mode === 'walking'
        ? Number(props.walk) === 1
        : Number(props.drive) === 1;

    if (!allowed) return;

    let lineParts = [];

    if (geometry.type === 'LineString') {
      lineParts = [geometry.coordinates];
    } else if (geometry.type === 'MultiLineString') {
      lineParts = geometry.coordinates;
    } else {
      return;
    }

    lineParts.forEach(coords => {
      if (!coords || coords.length < 2) return;

      for (let i = 0; i < coords.length - 1; i++) {
        const a = coords[i];
        const b = coords[i + 1];

        const aKey = coordKey(a);
        const bKey = coordKey(b);
        const dist = haversineDistance(a, b);

        if (!graph[aKey]) graph[aKey] = [];
        if (!graph[bKey]) graph[bKey] = [];

        graph[aKey].push({ node: bKey, coord: b, weight: dist });
        graph[bKey].push({ node: aKey, coord: a, weight: dist });

        if (!graphNodes.find(n => coordKey(n) === aKey)) graphNodes.push(a);
        if (!graphNodes.find(n => coordKey(n) === bKey)) graphNodes.push(b);
      }
    });
  });

  console.log('Graph nodes:', graphNodes.length);
  console.log('Graph keys:', Object.keys(graph).length);
}

function findNearestNode(coord) {
  if (!graphNodes.length) return null;

  let nearest = null;
  let minDist = Infinity;

  graphNodes.forEach(nodeCoord => {
    const dist = haversineDistance(coord, nodeCoord);
    if (dist < minDist) {
      minDist = dist;
      nearest = nodeCoord;
    }
  });

  return nearest;
}

function shortestPath(startCoord, endCoord) {
  const startKey = coordKey(startCoord);
  const endKey = coordKey(endCoord);

  const distances = {};
  const previous = {};
  const visited = new Set();

  Object.keys(graph).forEach(node => {
    distances[node] = Infinity;
    previous[node] = null;
  });

  distances[startKey] = 0;

  while (true) {
    let current = null;
    let smallest = Infinity;

    Object.keys(distances).forEach(node => {
      if (!visited.has(node) && distances[node] < smallest) {
        smallest = distances[node];
        current = node;
      }
    });

    if (current === null) break;
    if (current === endKey) break;

    visited.add(current);

    const neighbors = graph[current] || [];
    neighbors.forEach(neighbor => {
      const alt = distances[current] + neighbor.weight;
      if (alt < distances[neighbor.node]) {
        distances[neighbor.node] = alt;
        previous[neighbor.node] = current;
      }
    });
  }

  const path = [];
  let current = endKey;

  while (current) {
    const parts = current.split(',').map(Number);
    path.unshift(parts);
    current = previous[current];
  }

  if (!path.length || coordKey(path[0]) !== startKey) {
    return null;
  }

  return path;
}

/*********************************
 MANEUVERS + INSTRUCTIONS
*********************************/
function calculateBearing(a, b) {
  const toRad = deg => deg * Math.PI / 180;
  const toDeg = rad => rad * 180 / Math.PI;

  const lon1 = toRad(a[0]);
  const lat1 = toRad(a[1]);
  const lon2 = toRad(b[0]);
  const lat2 = toRad(b[1]);

  const y = Math.sin(lon2 - lon1) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1);

  let brng = toDeg(Math.atan2(y, x));
  brng = (brng + 360) % 360;
  return brng;
}

function normalizeAngle(angle) {
  let a = angle;
  while (a > 180) a -= 360;
  while (a < -180) a += 360;
  return a;
}

function classifyTurn(angleDiff) {
  if (angleDiff > -25 && angleDiff < 25) return 'Continue straight';
  if (angleDiff >= 25 && angleDiff < 120) return 'Turn right';
  if (angleDiff <= -25 && angleDiff > -120) return 'Turn left';
  if (angleDiff >= 120) return 'Make a sharp right';
  if (angleDiff <= -120) return 'Make a sharp left';
  return 'Continue';
}

function buildManeuvers(pathCoords) {
  const result = [];

  if (!pathCoords || pathCoords.length < 3) return result;

  for (let i = 1; i < pathCoords.length - 1; i++) {
    const prev = pathCoords[i - 1];
    const curr = pathCoords[i];
    const next = pathCoords[i + 1];

    const bearing1 = calculateBearing(prev, curr);
    const bearing2 = calculateBearing(curr, next);
    const angleDiff = normalizeAngle(bearing2 - bearing1);

    const instruction = classifyTurn(angleDiff);

    if (instruction !== 'Continue straight') {
      result.push({
        index: i,
        coordinate: curr,
        instruction,
        angle: angleDiff
      });
    }
  }

  result.push({
    index: pathCoords.length - 1,
    coordinate: pathCoords[pathCoords.length - 1],
    instruction: 'You have arrived',
    angle: 0
  });

  return result;
}

function renderManeuverList() {
  const box = document.getElementById('maneuverList');
  if (!box) return;

  box.innerHTML = '';

  maneuvers.forEach((m, idx) => {
    const div = document.createElement('div');
    div.className = 'maneuver-item';
    div.innerText = `${idx + 1}. ${m.instruction}`;
    box.appendChild(div);
  });
}

function getNextManeuver() {
  if (!maneuvers.length || !userLocation) return null;

  let nearest = null;
  let minDist = Infinity;

  maneuvers.forEach((m, idx) => {
    const dist = haversineDistance(userLocation, m.coordinate);
    if (dist < minDist && idx > announcedManeuverIndex) {
      minDist = dist;
      nearest = { ...m, maneuverIndex: idx, distance: dist };
    }
  });

  return nearest;
}

function updateNextInstruction() {
  const instructionEl = document.getElementById('navInstruction');
  const distEl = document.getElementById('navTurnDistance');

  if (!instructionEl || !distEl) return;

  const next = getNextManeuver();

  if (!next) {
    instructionEl.innerText = '-';
    distEl.innerText = '-';
    return;
  }

  if (next.instruction === 'You have arrived') {
    instructionEl.innerText = 'You have arrived';
    distEl.innerText = '';
    return;
  }

  if (next.distance <= 8) {
    instructionEl.innerText = `${next.instruction} now`;
  } else {
    instructionEl.innerText = `${next.instruction} in ${Math.round(next.distance)} m`;
  }

  distEl.innerText = `${Math.round(next.distance)} m`;
}

function speakInstruction(text) {
  if (!window.speechSynthesis) return;

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1;
  utterance.pitch = 1;
  window.speechSynthesis.speak(utterance);
}

function maybeSpeakNextInstruction() {
  const next = getNextManeuver();
  if (!next) return;

  if (next.maneuverIndex === announcedManeuverIndex) return;

  if (next.distance <= 20 && next.distance > 8) {
    speakInstruction(`${next.instruction} in ${Math.round(next.distance)} meters`);
    announcedManeuverIndex = next.maneuverIndex;
  } else if (next.distance <= 8) {
    speakInstruction(`${next.instruction} now`);
    announcedManeuverIndex = next.maneuverIndex;
  }
}

function minDistanceToPath(point, pathCoords) {
  let minDist = Infinity;
  pathCoords.forEach(coord => {
    const dist = haversineDistance(point, coord);
    if (dist < minDist) minDist = dist;
  });
  return minDist;
}

function updateMapHeading() {
  if (!previousUserLocation || !userLocation) {
    previousUserLocation = userLocation;
    return;
  }

  const moveDist = haversineDistance(previousUserLocation, userLocation);
  if (moveDist < 2) return;

  const heading = calculateBearing(previousUserLocation, userLocation);

  map.easeTo({
    bearing: heading,
    duration: 500
  });

  previousUserLocation = userLocation;
}

/*********************************
 DRAW ROUTE
*********************************/
function drawCustomRoute(pathCoords, mode = 'walking') {
  if (!pathCoords || !pathCoords.length) {
    alert('No path found');
    return;
  }

  currentRouteCoords = pathCoords;
  maneuvers = buildManeuvers(pathCoords);
  renderManeuverList();
  announcedManeuverIndex = -1;

  if (map.getSource('route')) {
    if (map.getLayer('route')) map.removeLayer('route');
    map.removeSource('route');
  }

  map.addSource('route', {
    type: 'geojson',
    data: {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: pathCoords
      }
    }
  });

  map.addLayer({
    id: 'route',
    type: 'line',
    source: 'route',
    paint: {
      'line-color': mode === 'walking' ? '#16a34a' : '#2563eb',
      'line-width': mode === 'walking' ? 4 : 5
    }
  });

  if (navigationActive) {
    const offRouteDistance = minDistanceToPath(userLocation, pathCoords);
    if (offRouteDistance > 15) {
      const statusEl = document.getElementById('navStatus');
      if (statusEl) statusEl.innerText = 'Off route';
    }
  }
}

/*********************************
 ROUTING ON CUSTOM NETWORK
*********************************/
function getNearestNodes(coord, count = 5) {
  if (!graphNodes.length || !coord) return [];

  const ranked = graphNodes.map(node => ({
    coord: node,
    dist: haversineDistance(coord, node)
  }));

  ranked.sort((a, b) => a.dist - b.dist);

  return ranked.slice(0, count).map(item => item.coord);
}

function routeOnCampusNetwork(destinationCoord, mode = 'walking') {
  if (!campusNetworkData) {
    alert('Campus network not loaded');
    return;
  }

  currentDestination = destinationCoord;
  currentMode = mode;

  buildGraphFromNetwork(mode);
  console.log('Graph nodes count:', graphNodes.length);
  console.log('Destination coord:', destinationCoord);
  console.log('User coord:', userLocation);

  const candidateStarts = getNearestNodes(userLocation, 6);
const candidateEnds = getNearestNodes(destinationCoord, 6);

let bestPath = null;
let bestDistance = Infinity;
let bestStart = null;
let bestEnd = null;

for (const s of candidateStarts) {
  for (const e of candidateEnds) {
    const path = shortestPath(s, e);

    if (path && path.length > 1) {
      const dist = calculatePathDistance(path);
      if (dist < bestDistance) {
        bestDistance = dist;
        bestPath = path;
        bestStart = s;
        bestEnd = e;
      }
    }
  }
}

if (!bestPath) {
  alert('No route found on the campus network');
  updateNavPanel({
    destination: currentDestinationName || '-',
    mode,
    distance: '-',
    eta: '-',
    status: 'No route found'
  });
  return;
}

drawCustomRoute(bestPath, mode);

const totalDistance = calculatePathDistance(bestPath);
const eta = estimateTime(totalDistance, mode);

updateNavPanel({
  destination: currentDestinationName || '-',
  mode,
  distance: formatDistance(totalDistance),
  eta,
  status: navigationActive ? 'Navigating' : 'Route ready'
});

// fallback: if building is not near network, snap anyway to closest node
if (!snappedEnd && graphNodes.length) {
  console.warn("Destination not near network, forcing snap");
  
  let minDist = Infinity;
  graphNodes.forEach(node => {
    const dist = haversineDistance(destinationCoord, node);
    if (dist < minDist) {
      minDist = dist;
      snappedEnd = node;
    }
  });
}

  if (!snappedStart || !snappedEnd) {
    alert('Could not snap start or destination to the campus network');
    updateNavPanel({
      destination: currentDestinationName || '-',
      mode,
      distance: '-',
      eta: '-',
      status: 'Snapping failed'
    });
    return;
  }


  if (!path) {
    alert('No route found on the campus network');
    updateNavPanel({
      destination: currentDestinationName || '-',
      mode,
      distance: '-',
      eta: '-',
      status: 'No route found'
    });
    return;
  }


  updateNavPanel({
    destination: currentDestinationName || '-',
    mode,
    distance: formatDistance(totalDistance),
    eta,
    status: navigationActive ? 'Navigating' : 'Route ready'
  });

  updateNextInstruction();
}

/*********************************
 LIVE TRACKING
*********************************/
function startLiveTracking() {
  if (watchId !== null) return;

  watchId = navigator.geolocation.watchPosition(
    pos => {
      userLocation = [pos.coords.longitude, pos.coords.latitude];

      if (!userMarker) {
        userMarker = new mapboxgl.Marker({ color: 'blue' })
          .setLngLat(userLocation)
          .setPopup(new mapboxgl.Popup().setText('You are here'))
          .addTo(map);
      } else {
        userMarker.setLngLat(userLocation);
      }

      updateMapHeading();
      updateNextInstruction();
      maybeSpeakNextInstruction();

      if (navigationActive && currentDestination && hasMovedEnough(userLocation)) {
        updateNavPanel({
          destination: currentDestinationName || '-',
          mode: currentMode,
          distance: document.getElementById('navDistance')?.innerText || '-',
          eta: document.getElementById('navEta')?.innerText || '-',
          status: 'Recalculating...'
        });

        routeOnCampusNetwork(currentDestination, currentMode);
      }
    },
    err => {
      console.warn('Live tracking failed:', err);
      updateNavPanel({
        destination: currentDestinationName || '-',
        mode: currentMode,
        distance: '-',
        eta: '-',
        status: 'Location unavailable'
      });
    },
    {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 5000
    }
  );
}

/*********************************
 LOAD DATA
*********************************/
map.on('load', () => {
  loadBuildings();
  loadOffices();
  loadAccessPoints();
  loadCampusNetwork();
  startLiveTracking();

  const toggle = document.getElementById('toggle3D');
  if (toggle) {
    toggle.addEventListener('change', toggle3D);
  }
});

function loadBuildings() {
  fetch('data/Buildings.geojson')
    .then(res => res.json())
    .then(data => {
      buildingsData = data;

      map.addSource('buildings', {
        type: 'geojson',
        data
      });

      map.addLayer({
        id: '3d-buildings',
        type: 'fill-extrusion',
        source: 'buildings',
        paint: {
          'fill-extrusion-color': '#cfcfcf',
          'fill-extrusion-height': [
            'coalesce',
            ['get', 'Building_Height(m)'],
            6
          ],
          'fill-extrusion-opacity': 0.9
        }
      });

      update3DBuildingStyle();
    })
    .catch(err => {
      console.error('Buildings load error:', err);
      alert('Buildings data failed to load.');
    });
}

function loadOffices() {
  fetch('data/Offices.geojson')
    .then(res => res.json())
    .then(data => {
      officesData = data;

      data.features.forEach(feature => {
        const coords = feature.geometry.coordinates;

        new mapboxgl.Marker({ color: 'purple' })
          .setLngLat(coords)
          .setPopup(
            new mapboxgl.Popup().setHTML(`
              <b>${feature.properties.Name || 'Office'}</b><br>
              Faculty: ${feature.properties.faculty || 'N/A'}<br>
              Building: ${feature.properties.building_name || 'N/A'}<br>
              Type: ${feature.properties.office_type || 'N/A'}<br>
              <button onclick="routeToOffice(${feature.properties.building_id})">Route here</button>
            `)
          )
          .addTo(map);
      });
    })
    .catch(err => {
      console.error('Offices load error:', err);
    });
}

function loadAccessPoints() {
  fetch('data/AccessPoints.geojson')
    .then(res => res.json())
    .then(data => {
      accessPointsData = data;
    })
    .catch(err => {
      console.error('Access points load error:', err);
    });
}

function loadCampusNetwork() {
  fetch('data/CampusNetwork.geojson')
    .then(res => res.json())
    .then(data => {
      campusNetworkData = data;

      map.addSource('campus-network', {
        type: 'geojson',
        data
      });

      map.addLayer({
        id: 'campus-network-layer',
        type: 'line',
        source: 'campus-network',
        paint: {
          'line-color': [
            'case',
            ['==', ['get', 'drive'], 1],
            '#444444',
            '#16a34a'
          ],
          'line-width': 2
        }
      });
    })
    .catch(err => {
      console.error('Campus network load error:', err);
    });
}

/*********************************
 SEARCH
*********************************/
function searchLocation() {
  const keyword = document.getElementById('searchInput').value.trim().toLowerCase();
  const mode = document.getElementById('routeMode').value;

  if (!keyword) {
    alert('Please enter a search term');
    return;
  }

  if (buildingsData && buildingsData.features) {
    const buildingFeature = buildingsData.features.find(f =>
      f.properties &&
      f.properties.Name &&
      f.properties.Name.toLowerCase().includes(keyword)
    );

    if (buildingFeature) {
      zoomToBuilding(buildingFeature, mode);
      clearSuggestions();
      return;
    }
  }

  if (officesData && officesData.features) {
    const officeFeature = officesData.features.find(f =>
      f.properties &&
      f.properties.Name &&
      f.properties.Name.toLowerCase().includes(keyword)
    );

    if (officeFeature) {
      routeToOffice(officeFeature.properties.building_id, mode);
      clearSuggestions();
      return;
    }
  }

  alert('Location not found');
}

/*********************************
 AUTOCOMPLETE
*********************************/
function showSuggestions() {
  const inputEl = document.getElementById('searchInput');
  const suggestionBox = document.getElementById('suggestions');

  if (!inputEl || !suggestionBox) return;

  const input = inputEl.value.trim().toLowerCase();
  suggestionBox.innerHTML = '';

  if (!input) return;

  const suggestions = [];

  if (buildingsData && buildingsData.features) {
    buildingsData.features.forEach(feature => {
      const name = feature.properties?.Name;
      if (name && name.toLowerCase().includes(input)) {
        suggestions.push({
          type: 'building',
          label: name,
          feature
        });
      }
    });
  }

  if (officesData && officesData.features) {
    officesData.features.forEach(feature => {
      const name = feature.properties?.Name;
      if (name && name.toLowerCase().includes(input)) {
        suggestions.push({
          type: 'office',
          label: name,
          feature
        });
      }
    });
  }

  suggestions.slice(0, 8).forEach(item => {
    const div = document.createElement('div');
    div.className = 'suggestion-item';
    div.innerText = `${item.label} (${item.type})`;

    div.onclick = () => {
      inputEl.value = item.label;
      clearSuggestions();

      if (item.type === 'building') {
        zoomToBuilding(item.feature, document.getElementById('routeMode').value);
      } else {
        routeToOffice(item.feature.properties.building_id, document.getElementById('routeMode').value);
      }
    };

    suggestionBox.appendChild(div);
  });
}

/*********************************
 ZOOM / ROUTE TO BUILDING / OFFICE
*********************************/
function zoomToBuilding(feature, mode = 'walking') {
  const destination = getFeatureCenter(feature);

  if (!destination) {
    alert('Invalid building geometry');
    return;
  }

  const buildingId = feature.properties?.id;
  if (buildingId !== undefined && buildingId !== null) {
    highlightBuilding(buildingId);
  }

  currentDestinationName = feature.properties?.Name || 'Selected Building';
  showSelectedBuildingLabel(feature);

  map.flyTo({
    center: destination,
    zoom: 18,
    pitch: is3DEnabled ? 60 : 0,
    bearing: is3DEnabled ? -20 : 0,
    essential: true
  });

  const accessPoint = getAccessPointByBuildingId(buildingId);
  const routeDestination = accessPoint || destination;

  routeOnCampusNetwork(routeDestination, mode);
}

function routeToOffice(buildingId, mode = null) {
  const routeMode = mode || document.getElementById('routeMode').value;
  const accessPoint = getAccessPointByBuildingId(buildingId);

  if (!accessPoint) {
    alert('No access point defined for this office/building');
    return;
  }

  if (buildingsData && buildingsData.features) {
    const buildingFeature = buildingsData.features.find(f =>
      f.properties && Number(f.properties.id) === Number(buildingId)
    );

    if (buildingFeature) {
      highlightBuilding(buildingId);
      showSelectedBuildingLabel(buildingFeature);
      currentDestinationName = buildingFeature.properties?.Name || 'Office Destination';
    }
  }

  map.flyTo({
    center: accessPoint,
    zoom: 18,
    pitch: is3DEnabled ? 60 : 0,
    bearing: is3DEnabled ? -20 : 0,
    essential: true
  });

  routeOnCampusNetwork(accessPoint, routeMode);
}

/*********************************
 NAVIGATION CONTROLS
*********************************/
function startNavigation() {
  if (!currentDestination) {
    alert('Please search for a destination first');
    return;
  }

  navigationActive = true;

  updateNavPanel({
    destination: currentDestinationName || '-',
    mode: currentMode,
    distance: document.getElementById('navDistance')?.innerText || '-',
    eta: document.getElementById('navEta')?.innerText || '-',
    status: 'Navigating'
  });

  routeOnCampusNetwork(currentDestination, currentMode);
}

function stopNavigation() {
  navigationActive = false;
  currentDestination = null;
  currentDestinationName = null;
  currentRouteCoords = [];
  maneuvers = [];
  announcedManeuverIndex = -1;

  if (map.getSource('route')) {
    if (map.getLayer('route')) map.removeLayer('route');
    map.removeSource('route');
  }

  const box = document.getElementById('maneuverList');
  if (box) box.innerHTML = '';

  updateNavPanel({
    destination: 'None',
    mode: '-',
    distance: '-',
    eta: '-',
    status: 'Stopped'
  });

  const instructionEl = document.getElementById('navInstruction');
  const turnDistEl = document.getElementById('navTurnDistance');
  if (instructionEl) instructionEl.innerText = '-';
  if (turnDistEl) turnDistEl.innerText = '-';
}

/*********************************
 3D TOGGLE
*********************************/
function toggle3D() {
  const checkbox = document.getElementById('toggle3D');
  if (!checkbox) return;

  is3DEnabled = checkbox.checked;

  if (!map.getLayer('3d-buildings')) return;

  if (is3DEnabled) {
    map.setLayoutProperty('3d-buildings', 'visibility', 'visible');

    map.easeTo({
      pitch: 60,
      bearing: -20,
      duration: 700
    });
  } else {
    map.setLayoutProperty('3d-buildings', 'visibility', 'none');

    map.easeTo({
      pitch: 0,
      bearing: 0,
      duration: 700
    });
  }
}