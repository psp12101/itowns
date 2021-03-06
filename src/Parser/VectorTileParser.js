import { Vector2, Vector3 } from 'three';
import Protobuf from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import { globalExtentTMS } from 'Core/Geographic/Extent';
import { FeatureCollection, FEATURE_TYPES } from 'Core/Feature';
import { featureFilter } from '@mapbox/mapbox-gl-style-spec';
import Style from 'Core/Style';

const worldDimension3857 = globalExtentTMS.get('EPSG:3857').dimensions();
const globalExtent = new Vector3(worldDimension3857.x, worldDimension3857.y, 1);
const lastPoint = new Vector2();
const firstPoint = new Vector2();
const styleCache = new Map();


// Classify option, it allows to classify a full polygon and its holes.
// Each polygon with its holes are in one FeatureGeometry.
// A polygon is determined by its clockwise direction and the holes are in the opposite direction.
// Clockwise direction is determined by Shoelace formula https://en.wikipedia.org/wiki/Shoelace_formula
// Draw polygon with canvas doesn't need to classify however it is necessary for meshs.
function vtFeatureToFeatureGeometry(vtFeature, feature, classify = false) {
    let geometry = feature.bindNewGeometry();
    classify = classify && (feature.type === FEATURE_TYPES.POLYGON);

    geometry.properties = vtFeature.properties;
    const pbf = vtFeature._pbf;
    pbf.pos = vtFeature._geometry;

    const end = pbf.readVarint() + pbf.pos;
    let cmd = 1;
    let length = 0;
    let x = 0;
    let y = 0;
    let count = 0;
    let sum = 0;

    while (pbf.pos < end) {
        if (length <= 0) {
            const cmdLen = pbf.readVarint();
            cmd = cmdLen & 0x7;
            length = cmdLen >> 3;
        }

        length--;

        if (cmd === 1 || cmd === 2) {
            x += pbf.readSVarint();
            y += pbf.readSVarint();

            if (cmd === 1) {
                if (count) {
                    if (classify && sum > 0 && geometry.indices.length > 0) {
                        feature.updateExtent(geometry);
                        geometry = feature.bindNewGeometry();
                        geometry.properties = vtFeature.properties;
                    }
                    geometry.closeSubGeometry(count, feature);
                    geometry.getLastSubGeometry().ccw = sum < 0;
                }
                count = 0;
                sum = 0;
            }
            count++;
            geometry.pushCoordinatesValues(feature, x, y);
            if (count == 1) {
                firstPoint.set(x, y);
                lastPoint.set(x, y);
            } else if (classify && count > 1) {
                sum += (lastPoint.x - x) * (lastPoint.y + y);
                lastPoint.set(x, y);
            }
        } else if (cmd === 7) {
            if (count) {
                count++;
                geometry.pushCoordinatesValues(feature, firstPoint.x, firstPoint.y);
                if (classify) {
                    sum += (lastPoint.x - firstPoint.x) * (lastPoint.y + firstPoint.y);
                }
            }
        } else {
            throw new Error(`unknown command ${cmd}`);
        }
    }

    if (count) {
        if (classify && sum > 0 && geometry.indices.length > 0) {
            feature.updateExtent(geometry);
            geometry = feature.bindNewGeometry();
            geometry.properties = vtFeature.properties;
        }
        geometry.closeSubGeometry(count, feature);
        geometry.getLastSubGeometry().ccw = sum < 0;
    }
    feature.updateExtent(geometry);
}

const defaultFilter = () => true;
function readPBF(file, options) {
    const vectorTile = new VectorTile(new Protobuf(file));
    const extentSource = options.extentSource || file.extent;
    const sourceLayers = Object.keys(vectorTile.layers);

    if (sourceLayers.length < 1) {
        return;
    }

    // x,y,z tile coordinates
    const x = extentSource.col;
    const z = extentSource.zoom;
    // We need to move from TMS to Google/Bing/OSM coordinates
    // https://alastaira.wordpress.com/2011/07/06/converting-tms-tile-coordinates-to-googlebingosm-tile-coordinates/
    // Only if the layer.origin is top
    const y = options.isInverted ? extentSource.row : (1 << z) - extentSource.row - 1;

    options.buildExtent = true;
    options.mergeFeatures = true;
    options.withAltitude = false;
    options.withNormal = false;

    const features = new FeatureCollection('EPSG:3857', options);
    // TODO remove defaultFilter;
    features.filter = options.filter || defaultFilter;

    const vFeature = vectorTile.layers[sourceLayers[0]];
    // TODO: verify if size is correct because is computed with only one feature (vFeature).
    const size = vFeature.extent * 2 ** z;
    const center = -0.5 * size;
    features.scale.set(size, -size, 1).divide(globalExtent);
    features.translation.set(-(vFeature.extent * x + center), -(vFeature.extent * y + center), 0).divide(features.scale);

    const allLayers = features.filter;
    if (!features.filter.loaded) {
        allLayers.forEach((l) => {
            l.filterExpression = featureFilter(l.filter);
        });
        features.filter.loaded = true;
    }

    sourceLayers.forEach((layer_id) => {
        const sourceLayer = vectorTile.layers[layer_id];
        const layersSource = allLayers.filter(l => sourceLayer.name == l['source-layer']);
        for (let i = sourceLayer.length - 1; i >= 0; i--) {
            const vtFeature = sourceLayer.feature(i);
            const layers = layersSource.filter(l => l.filterExpression.filter({ zoom: z }, vtFeature) &&
                (l.minzoom == undefined || z >= l.minzoom) &&
                (l.maxzoom == undefined || z < l.maxzoom));
            let feature;
            for (const layer of layers) {
                const tag = `${layer.sourceUid}_${layer.id}_zoom_${z}`;
                // Fix doens't pass instance of properties
                let style = styleCache.get(tag);
                if (!style) {
                    style = new Style();
                    style.setFromVectorTileLayer(layer, extentSource.zoom, options.sprites, options.symbolToCircle);
                    styleCache.set(tag, style);
                }
                const order = allLayers.findIndex(l => l.id == layer.id);
                if (!feature) {
                    feature = features.requestFeatureById(layer.id, vtFeature.type - 1);
                    feature.id = layer.id;
                    feature.order = order;
                    feature.style = style;
                    vtFeatureToFeatureGeometry(vtFeature, feature);
                } else if (!features.features.find(f => f.id === layer.id)) {
                    feature = features.newFeatureByReference(feature);
                    feature.id = layer.id;
                    feature.order = order;
                    feature.style = style;
                }
            }
        }
    });

    features.removeEmptyFeature();
    // TODO verify if is needed to updateExtent for previous features.
    features.updateExtent();
    features.features.sort((a, b) => (a.order - b.order));
    features.extent = extentSource;
    return Promise.resolve(features);
}

/**
 * @module VectorTileParser
 */
export default {
    /**
     * Parse a vector tile file and return a [Feature]{@link module:GeoJsonParser.Feature}
     * or an array of Features. While multiple formats of vector tile are
     * available, the only one supported for the moment is the
     * [Mapbox Vector Tile]{@link https://www.mapbox.com/vector-tiles/specification/}.
     *
     * @param {ArrayBuffer} file - The vector tile file to parse.
     * @param {Object} options - Options controlling the parsing.
     * @param {Extent} options.extent - The Extent to convert the input coordinates to.
     * @param {Extent=} options.filteringExtent - Optional filter to reject features
     * outside of this extent.
     * @param {boolean} [options.mergeFeatures=true] - If true all geometries are merged by type and multi-type
     * @param {boolean} [options.withNormal=true] - If true each coordinate normal is computed
     * @param {boolean} [options.withAltitude=true] - If true each coordinate altitude is kept
     * @param {function=} options.filter - Filter function to remove features.
     * @param {string=} options.isInverted - This option is to be set to the
     * correct value, true or false (default being false), if the computation of
     * the coordinates needs to be inverted to same scheme as OSM, Google Maps
     * or other system. See [this link]{@link
     * https://alastaira.wordpress.com/2011/07/06/converting-tms-tile-coordinates-to-googlebingosm-tile-coordinates}
     * for more informations.
     * @param {boolean} [options.symbolToCircle=false] - If true, all symbols
     * from a tile will be considered as circle, and render as circles.
     *
     * @return {Promise} A Promise resolving with a Feature or an array a
     * Features.
     */
    parse(file, options) {
        return Promise.resolve(readPBF(file, options));
    },
};
