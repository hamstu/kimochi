//! Google Lens as a selectable OCR engine (`ocrMode: "googlelens"`).
//!
//! Provenance: this is a Rust port of the Google Lens engine in owocr by AuroraWright
//! (<https://github.com/AuroraWright/owocr>, `owocr/ocr.py`, class `GoogleLens`, at revision
//! 5ddee7961a9b5b4a50fa0b2afc41f9eea72bb5d5), GPL-3.0-only. The request it builds, the endpoint
//! and headers it posts to, the image size limit and the way text and geometry are read back are
//! all taken from there. The protobuf messages below are a hand-written subset of the Lens
//! overlay protos owocr generates its bindings from (Chromium's
//! `third_party/lens_server_proto`, BSD-3-Clause): only the fields this module sends or reads,
//! with their original field numbers. See NOTICE.
//!
//! The endpoint is the one Chrome's Lens overlay uses. It is unofficial and undocumented: Google
//! can change or close it at any time, and every scan sends the captured image to Google.
//!
//! The result has the shape every native engine returns (see `livetext.rs`): one authoritative
//! group per Lens paragraph, with the paragraph's lines as `linePolygons` (rotated where Lens
//! says the text is rotated) and its text as those lines joined by newlines; a `line`
//! annotation per line; the aggregate first. Coordinates are pixels of the frame that was
//! captured, whatever size the image was sent at.
use serde_json::{json, Value};
use std::io::Cursor;
use std::sync::OnceLock;
use std::time::Duration;

const ENDPOINT: &str = "https://lensfrontend-pa.googleapis.com/v1/crupload";
/// The public key Chrome's Lens overlay sends; owocr sends the same one.
const API_KEY: &str = "AIzaSyDr2UxVnv_U85AbhhY8XSHSIavUW0DC-sY";
/// Larger images are scaled down to this many pixels before upload, keeping the aspect ratio
/// (owocr's limit).
const MAX_PIXELS: u64 = 3_000_000;
const TIMEOUT: Duration = Duration::from_secs(20);
/// `lens.Platform.PLATFORM_WEB`, `lens.Surface.SURFACE_CHROMIUM`,
/// `lens.LensOverlayFilterType.AUTO_FILTER`.
const PLATFORM_WEB: i32 = 3;
const SURFACE_CHROMIUM: i32 = 4;
const AUTO_FILTER: i32 = 7;
/// `lens.WritingDirection.WRITING_DIRECTION_TOP_TO_BOTTOM`.
const TOP_TO_BOTTOM: i32 = 2;
/// `lens.CoordinateType.IMAGE`: pixels of the uploaded image. Anything else is normalised 0–1.
const COORDINATE_IMAGE: i32 = 2;

/// The subset of the Lens overlay protocol this engine uses. Field numbers are the upstream ones;
/// fields not listed here are skipped when decoding and never sent.
pub(crate) mod proto {
    #[derive(Clone, PartialEq, prost::Message)]
    pub struct ServerRequest {
        #[prost(message, optional, tag = "1")]
        pub objects_request: Option<ObjectsRequest>,
    }
    #[derive(Clone, PartialEq, prost::Message)]
    pub struct ObjectsRequest {
        #[prost(message, optional, tag = "1")]
        pub request_context: Option<RequestContext>,
        #[prost(message, optional, tag = "3")]
        pub image_data: Option<ImageData>,
    }
    #[derive(Clone, PartialEq, prost::Message)]
    pub struct RequestContext {
        #[prost(message, optional, tag = "3")]
        pub request_id: Option<RequestId>,
        #[prost(message, optional, tag = "4")]
        pub client_context: Option<ClientContext>,
    }
    #[derive(Clone, PartialEq, prost::Message)]
    pub struct RequestId {
        #[prost(uint64, tag = "1")]
        pub uuid: u64,
        #[prost(int32, tag = "2")]
        pub sequence_id: i32,
        #[prost(int32, tag = "3")]
        pub image_sequence_id: i32,
        #[prost(bytes = "vec", tag = "4")]
        pub analytics_id: Vec<u8>,
        /// Sent present but empty, as Chrome (and owocr) do.
        #[prost(message, optional, tag = "6")]
        pub routing_info: Option<RoutingInfo>,
    }
    #[derive(Clone, PartialEq, prost::Message)]
    pub struct RoutingInfo {}
    #[derive(Clone, PartialEq, prost::Message)]
    pub struct ClientContext {
        #[prost(int32, tag = "1")]
        pub platform: i32,
        #[prost(int32, tag = "2")]
        pub surface: i32,
        #[prost(message, optional, tag = "4")]
        pub locale_context: Option<LocaleContext>,
        #[prost(message, optional, tag = "17")]
        pub client_filters: Option<AppliedFilters>,
    }
    #[derive(Clone, PartialEq, prost::Message)]
    pub struct LocaleContext {
        #[prost(string, tag = "1")]
        pub language: String,
        #[prost(string, tag = "2")]
        pub region: String,
    }
    #[derive(Clone, PartialEq, prost::Message)]
    pub struct AppliedFilters {
        #[prost(message, repeated, tag = "1")]
        pub filter: Vec<AppliedFilter>,
    }
    #[derive(Clone, PartialEq, prost::Message)]
    pub struct AppliedFilter {
        #[prost(int32, tag = "1")]
        pub filter_type: i32,
    }
    #[derive(Clone, PartialEq, prost::Message)]
    pub struct ImageData {
        #[prost(message, optional, tag = "1")]
        pub payload: Option<ImagePayload>,
        #[prost(message, optional, tag = "3")]
        pub image_metadata: Option<ImageMetadata>,
    }
    #[derive(Clone, PartialEq, prost::Message)]
    pub struct ImagePayload {
        #[prost(bytes = "vec", tag = "1")]
        pub image_bytes: Vec<u8>,
    }
    #[derive(Clone, PartialEq, prost::Message)]
    pub struct ImageMetadata {
        #[prost(int32, tag = "1")]
        pub width: i32,
        #[prost(int32, tag = "2")]
        pub height: i32,
    }

    #[derive(Clone, PartialEq, prost::Message)]
    pub struct ServerResponse {
        #[prost(message, optional, tag = "1")]
        pub error: Option<ServerError>,
        #[prost(message, optional, tag = "2")]
        pub objects_response: Option<ObjectsResponse>,
    }
    #[derive(Clone, PartialEq, prost::Message)]
    pub struct ServerError {
        #[prost(int32, tag = "1")]
        pub error_type: i32,
    }
    #[derive(Clone, PartialEq, prost::Message)]
    pub struct ObjectsResponse {
        #[prost(message, optional, tag = "3")]
        pub text: Option<Text>,
    }
    #[derive(Clone, PartialEq, prost::Message)]
    pub struct Text {
        #[prost(message, optional, tag = "1")]
        pub text_layout: Option<TextLayout>,
        #[prost(string, tag = "2")]
        pub content_language: String,
    }
    #[derive(Clone, PartialEq, prost::Message)]
    pub struct TextLayout {
        #[prost(message, repeated, tag = "1")]
        pub paragraphs: Vec<Paragraph>,
    }
    #[derive(Clone, PartialEq, prost::Message)]
    pub struct Paragraph {
        #[prost(message, repeated, tag = "2")]
        pub lines: Vec<Line>,
        #[prost(message, optional, tag = "3")]
        pub geometry: Option<Geometry>,
        #[prost(int32, tag = "4")]
        pub writing_direction: i32,
    }
    #[derive(Clone, PartialEq, prost::Message)]
    pub struct Line {
        #[prost(message, repeated, tag = "1")]
        pub words: Vec<Word>,
        #[prost(message, optional, tag = "2")]
        pub geometry: Option<Geometry>,
    }
    #[derive(Clone, PartialEq, prost::Message)]
    pub struct Word {
        #[prost(string, tag = "2")]
        pub plain_text: String,
        #[prost(string, optional, tag = "3")]
        pub text_separator: Option<String>,
        #[prost(message, optional, tag = "4")]
        pub geometry: Option<Geometry>,
    }
    #[derive(Clone, PartialEq, prost::Message)]
    pub struct Geometry {
        #[prost(message, optional, tag = "1")]
        pub bounding_box: Option<CenterRotatedBox>,
    }
    #[derive(Clone, PartialEq, prost::Message)]
    pub struct CenterRotatedBox {
        #[prost(float, tag = "1")]
        pub center_x: f32,
        #[prost(float, tag = "2")]
        pub center_y: f32,
        #[prost(float, tag = "3")]
        pub width: f32,
        #[prost(float, tag = "4")]
        pub height: f32,
        /// Radians, clockwise in image space.
        #[prost(float, tag = "5")]
        pub rotation_z: f32,
        #[prost(int32, tag = "6")]
        pub coordinate_type: i32,
    }
}

/// The image as it is uploaded: PNG bytes and their dimensions.
struct Upload {
    png: Vec<u8>,
    width: u32,
    height: u32,
}

/// Recognise one captured PNG with Google Lens.
pub fn recognize(png: &[u8]) -> Result<Value, String> {
    let (width, height) = dimensions(png)?;
    let upload = prepare(png, width, height)?;
    let bytes = post(&upload)?;
    let parsed = parse(&bytes)?;
    Ok(value_from_response(&parsed, &upload, width, height))
}

/// Send the image; the raw response body.
fn post(upload: &Upload) -> Result<Vec<u8>, String> {
    let body = prost::Message::encode_to_vec(&request(upload, random_u64(), random_bytes()));
    let response = client()?
        .post(ENDPOINT)
        .header("Content-Type", "application/x-protobuf")
        .header("X-Goog-Api-Key", API_KEY)
        .header("Sec-Fetch-Mode", "no-cors")
        .header("Sec-Fetch-Dest", "empty")
        .body(body)
        .send()
        .map_err(|_| "native: Google Lens network request failed (connection/TLS/timeout)")?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("native: Google Lens HTTP {}", status.as_u16()));
    }
    response
        .bytes()
        .map(|b| b.to_vec())
        .map_err(|_| "native: Google Lens response was cut off".to_string())
}

/// One HTTP client for the process, so consecutive scans reuse the connection.
fn client() -> Result<&'static reqwest::blocking::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::blocking::Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::blocking::Client::builder()
                // The endpoint serves Chrome; a browser-like agent keeps it from treating the
                // request as an unknown client.
                .user_agent(
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
                     (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
                )
                .timeout(TIMEOUT)
                .build()
                .map_err(|_| "native: could not initialize Google Lens HTTP client".to_string())
        })
        .as_ref()
        .map_err(Clone::clone)
}

fn dimensions(png: &[u8]) -> Result<(u32, u32), String> {
    image::ImageReader::with_format(Cursor::new(png), image::ImageFormat::Png)
        .into_dimensions()
        .map_err(|e| format!("native: unreadable capture: {e}"))
}

/// owocr's preprocessing: anything over `MAX_PIXELS` is scaled down (Lanczos) to fit, aspect
/// ratio kept; anything else is sent as captured.
fn prepare(png: &[u8], width: u32, height: u32) -> Result<Upload, String> {
    let Some((new_width, new_height)) = scaled_size(width, height) else {
        return Ok(Upload {
            png: png.to_vec(),
            width,
            height,
        });
    };
    let decoded = image::load_from_memory_with_format(png, image::ImageFormat::Png)
        .map_err(|e| format!("native: unreadable capture: {e}"))?;
    let resized =
        decoded.resize_exact(new_width, new_height, image::imageops::FilterType::Lanczos3);
    let mut out = Vec::new();
    resized
        .write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png)
        .map_err(|e| format!("native: could not encode the capture: {e}"))?;
    Ok(Upload {
        png: out,
        width: new_width,
        height: new_height,
    })
}

/// The size to scale to, or None when the image is within the limit.
fn scaled_size(width: u32, height: u32) -> Option<(u32, u32)> {
    if u64::from(width) * u64::from(height) <= MAX_PIXELS || width == 0 || height == 0 {
        return None;
    }
    let aspect = f64::from(width) / f64::from(height);
    let new_width = (MAX_PIXELS as f64 * aspect).sqrt().floor().max(1.);
    let new_height = (new_width / aspect).floor().max(1.);
    Some((new_width as u32, new_height as u32))
}

/// The request owocr sends: a Chromium web client asking in Japanese, with the auto filter.
fn request(upload: &Upload, uuid: u64, analytics_id: [u8; 16]) -> proto::ServerRequest {
    use proto::*;
    ServerRequest {
        objects_request: Some(ObjectsRequest {
            request_context: Some(RequestContext {
                request_id: Some(RequestId {
                    uuid,
                    sequence_id: 0,
                    image_sequence_id: 0,
                    analytics_id: analytics_id.to_vec(),
                    routing_info: Some(RoutingInfo {}),
                }),
                client_context: Some(ClientContext {
                    platform: PLATFORM_WEB,
                    surface: SURFACE_CHROMIUM,
                    locale_context: Some(LocaleContext {
                        language: "ja".into(),
                        region: "Asia/Tokyo".into(),
                    }),
                    client_filters: Some(AppliedFilters {
                        filter: vec![AppliedFilter {
                            filter_type: AUTO_FILTER,
                        }],
                    }),
                }),
            }),
            image_data: Some(ImageData {
                payload: Some(ImagePayload {
                    image_bytes: upload.png.clone(),
                }),
                image_metadata: Some(ImageMetadata {
                    width: upload.width as i32,
                    height: upload.height as i32,
                }),
            }),
        }),
    }
}

fn parse(bytes: &[u8]) -> Result<proto::ServerResponse, String> {
    let response = <proto::ServerResponse as prost::Message>::decode(bytes)
        .map_err(|_| "native: Google Lens returned an unreadable response")?;
    match (&response.error, &response.objects_response) {
        (Some(error), None) => Err(format!(
            "native: Google Lens refused the request (error {})",
            error.error_type
        )),
        _ => Ok(response),
    }
}

/// A box's four corners in pixels of the captured frame, clockwise from top left before rotation.
fn corners(
    geometry: Option<&proto::Geometry>,
    upload: &Upload,
    width: u32,
    height: u32,
) -> Option<[[f64; 2]; 4]> {
    let b = geometry?.bounding_box.as_ref()?;
    // Normalised boxes scale to the frame; pixel boxes are in the uploaded image's pixels.
    let (sx, sy) = if b.coordinate_type == COORDINATE_IMAGE {
        (
            f64::from(width) / f64::from(upload.width.max(1)),
            f64::from(height) / f64::from(upload.height.max(1)),
        )
    } else {
        (f64::from(width), f64::from(height))
    };
    let (cx, cy) = (f64::from(b.center_x) * sx, f64::from(b.center_y) * sy);
    let (hw, hh) = (f64::from(b.width) * sx / 2., f64::from(b.height) * sy / 2.);
    let values = [cx, cy, hw, hh, f64::from(b.rotation_z)];
    if !values.iter().all(|v| v.is_finite()) || hw <= 0. || hh <= 0. {
        return None;
    }
    let (sin, cos) = f64::from(b.rotation_z).sin_cos();
    let clamp = |v: f64, max: u32| v.clamp(0., f64::from(max));
    Some([[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(|[x, y]| {
        [
            clamp(cx + x * cos - y * sin, width),
            clamp(cy + x * sin + y * cos, height),
        ]
    }))
}

/// The axis-aligned box around some corners: `[x1, y1, x2, y2]`.
fn bounds<'a>(points: impl IntoIterator<Item = &'a [f64; 2]>) -> Option<[f64; 4]> {
    let mut b = [
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    ];
    for [x, y] in points {
        b = [b[0].min(*x), b[1].min(*y), b[2].max(*x), b[3].max(*y)];
    }
    (b[0] < b[2] && b[1] < b[3]).then_some(b)
}

/// A line's text: its words, each followed by the separator Lens recorded after it (a space
/// between English words, nothing between Japanese ones).
fn line_text(line: &proto::Line) -> String {
    let mut text = String::new();
    for (index, word) in line.words.iter().enumerate() {
        text.push_str(&word.plain_text);
        if index + 1 < line.words.len() {
            text.push_str(word.text_separator.as_deref().unwrap_or(""));
        }
    }
    text.trim().to_string()
}

fn value_from_response(
    response: &proto::ServerResponse,
    upload: &Upload,
    width: u32,
    height: u32,
) -> Value {
    let paragraphs = response
        .objects_response
        .as_ref()
        .and_then(|o| o.text.as_ref())
        .and_then(|t| t.text_layout.as_ref())
        .map_or(&[][..], |l| &l.paragraphs[..]);
    let mut groups = Vec::new();
    let mut annotations = Vec::new();
    let mut texts = Vec::new();
    for (index, paragraph) in paragraphs.iter().enumerate() {
        let lines: Vec<(String, Option<[[f64; 2]; 4]>)> = paragraph
            .lines
            .iter()
            .map(|line| {
                (
                    line_text(line),
                    corners(line.geometry.as_ref(), upload, width, height),
                )
            })
            .filter(|(text, _)| !text.is_empty())
            .collect();
        if lines.is_empty() {
            continue;
        }
        let text = lines
            .iter()
            .map(|(t, _)| t.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        let id = format!("googlelens-paragraph-{index}");
        let polygons: Vec<[[f64; 2]; 4]> = lines.iter().filter_map(|(_, c)| *c).collect();
        let bbox = bounds(polygons.iter().flatten()).or_else(|| {
            corners(paragraph.geometry.as_ref(), upload, width, height)
                .and_then(|c| bounds(c.iter()))
        });
        // Lens says when a paragraph is set top to bottom. When it does not, columns taller
        // than they are wide still read as vertical (the rule Live Text uses), so a vertical
        // block is never laid out sideways for want of the flag.
        let tall = |c: &[[f64; 2]; 4], t: &str| {
            bounds(c.iter())
                .is_some_and(|b| t.chars().count() > 1 && b[3] - b[1] > (b[2] - b[0]) * 1.5)
        };
        let vertical = paragraph.writing_direction == TOP_TO_BOTTOM
            || (!lines.is_empty()
                && lines
                    .iter()
                    .all(|(t, c)| c.as_ref().is_some_and(|c| tall(c, t))));
        let orientation = if vertical { "vertical" } else { "horizontal" };
        groups.push(json!({
            "id": id,
            "text": text,
            "bbox": bbox,
            "orientation": orientation,
            "linePolygons": polygons,
        }));
        for (line_text, polygon) in &lines {
            if let Some(polygon) = polygon {
                annotations.push(json!({
                    "description": line_text,
                    "boundingPoly": {"vertices": polygon.iter().map(|[x, y]| json!({"x": x, "y": y})).collect::<Vec<_>>()},
                    "orientation": orientation,
                    "isVertical": vertical,
                    "granularity": "line",
                    "groupId": id,
                }));
            }
        }
        texts.push(text);
    }
    let text = texts.join("\n");
    if !annotations.is_empty() {
        annotations.insert(0, json!({
            "description": text, "granularity": "aggregate",
            "boundingPoly": {"vertices": [{"x": 0, "y": 0}, {"x": width, "y": 0}, {"x": width, "y": height}, {"x": 0, "y": height}]}
        }));
    }
    json!({
        "fullText": text,
        "textAnnotations": annotations,
        "groups": groups,
        "engine": "googlelens",
        "geometry": !annotations.is_empty(),
    })
}

/// Request ids need only be unpredictable enough not to collide, not secret: the standard
/// library's randomly keyed hasher, seeded afresh each call, is plenty and adds no dependency.
fn random_u64() -> u64 {
    use std::hash::{BuildHasher, Hasher};
    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
    hasher.write_u128(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos()),
    );
    hasher.finish()
}

fn random_bytes() -> [u8; 16] {
    let mut out = [0; 16];
    out[..8].copy_from_slice(&random_u64().to_le_bytes());
    out[8..].copy_from_slice(&random_u64().to_le_bytes());
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use prost::Message;

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    /// owocr's request for the same inputs, serialised by Python protobuf from owocr's own
    /// generated bindings (uuid 0x0123456789ABCDEF, analytics id 00..0f, payload "PNGDATA",
    /// 640×480).
    const OWOCR_REQUEST: &str = "0a560a3f1a1e08ef9bafcdf8acd191012210000102030405060708090a0b0c0d0e0f3200221d0803100422100a026a61120a417369612f546f6b796f8a01040a0208071a130a090a07504e47444154411a0608800510e003";

    /// A response serialised the same way: a top-to-bottom paragraph of two columns
    /// (吾輩は猫 / である, normalised coordinates) and a horizontal one (Hello world).
    const RESPONSE: &str = "12dc021ad9020ad2020a80021280010a221206e590bee8bca91a0022160a140d3333533f159a99993e1dcdcc4c3d25cdcccc3d0a1f1203e381af1a0022160a140d3333533f159a99993e1dcdcc4c3d25cdcccc3d0a1f1203e78cab1a0022160a140d3333533f159a99993e1dcdcc4c3d25cdcccc3d12180a160d3333533f159a99993e1dcdcc4c3d25cdcccc3e3001125f0a1f1203e381a71a0022160a140d6666463f159a99993e1dcdcc4c3d25cdcccc3d0a221206e38182e3828b1a0022160a140d6666463f159a99993e1dcdcc4c3d25cdcccc3d12180a160d6666463f159a99993e1dcdcc4c3d25cdcccc3e30011a180a160dcdcc4c3f159a99993e1dcdcccc3d25cdcccc3e300120020a4d12310a0a120548656c6c6f1a01200a091205776f726c641a0012180a160d9a99993e156666663f1dcdcccc3e25cdcc4c3d30011a180a160d9a99993e156666663f1dcdcccc3e25cdcc4c3d300112026a61";

    fn upload(width: u32, height: u32) -> Upload {
        Upload {
            png: b"PNGDATA".to_vec(),
            width,
            height,
        }
    }

    #[test]
    fn the_request_is_byte_for_byte_owocrs() {
        let bytes = request(
            &upload(640, 480),
            0x0123_4567_89AB_CDEF,
            std::array::from_fn(|i| i as u8),
        )
        .encode_to_vec();
        assert_eq!(bytes, hex(OWOCR_REQUEST));
    }

    #[test]
    fn paragraphs_become_groups_with_their_lines_and_direction() {
        let response = parse(&hex(RESPONSE)).unwrap();
        let value = value_from_response(&response, &upload(1000, 500), 1000, 500);
        assert_eq!(value["engine"], "googlelens");
        assert_eq!(value["fullText"], "吾輩は猫\nである\nHello world");
        let groups = value["groups"].as_array().unwrap();
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0]["id"], "googlelens-paragraph-0");
        assert_eq!(groups[0]["text"], "吾輩は猫\nである");
        assert_eq!(groups[0]["orientation"], "vertical");
        assert_eq!(groups[1]["text"], "Hello world");
        assert_eq!(groups[1]["orientation"], "horizontal");
        // Normalised boxes land in frame pixels: the first column is centred on x 825, y 150.
        let column = groups[0]["linePolygons"][0].as_array().unwrap();
        let point = |i: usize| {
            (
                column[i][0].as_f64().unwrap(),
                column[i][1].as_f64().unwrap(),
            )
        };
        let ((x1, y1), (x2, y2)) = (point(0), point(2));
        assert!(
            (x1 - 800.).abs() < 0.01 && (x2 - 850.).abs() < 0.01,
            "{x1} {x2}"
        );
        assert!(
            (y1 - 50.).abs() < 0.01 && (y2 - 250.).abs() < 0.01,
            "{y1} {y2}"
        );
        let bbox: Vec<f64> = serde_json::from_value(groups[0]["bbox"].clone()).unwrap();
        assert!(
            (bbox[0] - 750.).abs() < 0.01 && (bbox[2] - 850.).abs() < 0.01,
            "{bbox:?}"
        );
        // Aggregate first, then one line annotation per line, tied to its group.
        let annotations = value["textAnnotations"].as_array().unwrap();
        assert_eq!(annotations.len(), 4);
        assert_eq!(annotations[0]["granularity"], "aggregate");
        assert_eq!(annotations[1]["description"], "吾輩は猫");
        assert_eq!(annotations[1]["groupId"], "googlelens-paragraph-0");
        assert_eq!(annotations[1]["isVertical"], true);
        assert_eq!(annotations[3]["description"], "Hello world");
        assert_eq!(value["geometry"], true);
    }

    #[test]
    fn coordinates_follow_the_frame_when_the_upload_was_scaled() {
        let response = parse(&hex(RESPONSE)).unwrap();
        // Sent at half size: normalised boxes still map onto the full frame.
        let value = value_from_response(&response, &upload(500, 250), 1000, 500);
        let bbox: Vec<f64> = serde_json::from_value(value["groups"][1]["bbox"].clone()).unwrap();
        assert!(
            (bbox[0] - 100.).abs() < 0.01 && (bbox[2] - 500.).abs() < 0.01,
            "{bbox:?}"
        );
        // Pixel boxes are in the uploaded image's pixels and scale up with it.
        let mut pixel = proto::Geometry {
            bounding_box: Some(proto::CenterRotatedBox {
                center_x: 100.,
                center_y: 50.,
                width: 20.,
                height: 10.,
                rotation_z: 0.,
                coordinate_type: COORDINATE_IMAGE,
            }),
        };
        let c = corners(Some(&pixel), &upload(500, 250), 1000, 500).unwrap();
        assert_eq!(c[0], [180., 90.]);
        assert_eq!(c[2], [220., 110.]);
        // A quarter turn swaps the box's extent.
        pixel.bounding_box.as_mut().unwrap().rotation_z = std::f32::consts::FRAC_PI_2;
        let c = corners(Some(&pixel), &upload(1000, 500), 1000, 500).unwrap();
        let b = bounds(c.iter()).unwrap();
        assert!(
            (b[2] - b[0] - 10.).abs() < 1e-3 && (b[3] - b[1] - 20.).abs() < 1e-3,
            "{b:?}"
        );
    }

    #[test]
    fn tall_columns_read_vertical_even_without_the_flag() {
        let geometry = |cx: f32| proto::Geometry {
            bounding_box: Some(proto::CenterRotatedBox {
                center_x: cx,
                center_y: 0.5,
                width: 0.05,
                height: 0.6,
                ..Default::default()
            }),
        };
        let word = |t: &str| proto::Word {
            plain_text: t.into(),
            ..Default::default()
        };
        let response = proto::ServerResponse {
            objects_response: Some(proto::ObjectsResponse {
                text: Some(proto::Text {
                    text_layout: Some(proto::TextLayout {
                        paragraphs: vec![proto::Paragraph {
                            lines: vec![proto::Line {
                                words: vec![word("縦書き")],
                                geometry: Some(geometry(0.5)),
                            }],
                            ..Default::default()
                        }],
                    }),
                    ..Default::default()
                }),
            }),
            ..Default::default()
        };
        let value = value_from_response(&response, &upload(400, 400), 400, 400);
        assert_eq!(value["groups"][0]["orientation"], "vertical");
    }

    #[test]
    fn an_empty_or_refused_response() {
        let value = value_from_response(&proto::ServerResponse::default(), &upload(10, 10), 10, 10);
        assert_eq!(value["fullText"], "");
        assert_eq!(value["textAnnotations"], json!([]));
        assert_eq!(value["groups"], json!([]));
        assert_eq!(value["geometry"], false);
        let refused = proto::ServerResponse {
            error: Some(proto::ServerError { error_type: 1 }),
            objects_response: None,
        }
        .encode_to_vec();
        assert!(parse(&refused).unwrap_err().contains("refused"));
        assert!(parse(b"\xff\xff\xff").is_err());
    }

    #[test]
    fn large_captures_are_scaled_to_three_megapixels() {
        assert_eq!(scaled_size(1920, 1080), None);
        let (w, h) = scaled_size(3840, 2160).unwrap();
        assert!(u64::from(w) * u64::from(h) <= MAX_PIXELS);
        assert!((f64::from(w) / f64::from(h) - 16. / 9.).abs() < 0.01);
    }

    /// One real request, run by hand: `KIMOCHI_LENS_IMAGE=path/to.png cargo test --
    /// google_lens::tests::live --ignored --nocapture`. Sends that image to Google;
    /// `KIMOCHI_LENS_DUMP=path` also keeps the raw response.
    #[test]
    #[ignore = "network: sends an image to Google Lens"]
    fn live() {
        let path = std::env::var("KIMOCHI_LENS_IMAGE").expect("set KIMOCHI_LENS_IMAGE");
        let png = std::fs::read(path).unwrap();
        let (width, height) = dimensions(&png).unwrap();
        let upload = prepare(&png, width, height).unwrap();
        let bytes = post(&upload).unwrap();
        if let Ok(dump) = std::env::var("KIMOCHI_LENS_DUMP") {
            std::fs::write(dump, &bytes).unwrap();
        }
        let value = value_from_response(&parse(&bytes).unwrap(), &upload, width, height);
        println!(
            "{}",
            serde_json::to_string_pretty(&value["groups"]).unwrap()
        );
        println!("fullText:\n{}", value["fullText"].as_str().unwrap());
        assert!(!value["fullText"].as_str().unwrap().is_empty());
    }
}
