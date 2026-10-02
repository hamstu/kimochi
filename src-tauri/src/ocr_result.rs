//! Engine-independent OCR units retained in scan history.
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Orientation { Horizontal, Vertical }
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrGroup {
    pub id: String,
    pub text: String,
    pub bbox: Option<[f64; 4]>,
    pub orientation: Orientation,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_polygons: Option<Vec<Vec<[f64; 2]>>>,
}
impl OcrGroup {
    pub fn validate(&self) -> bool {
        !self.id.is_empty() && !self.text.trim().is_empty() && self.bbox.is_none_or(|b| b.iter().all(|v|v.is_finite()) && b[0]<b[2] && b[1]<b[3])
    }
}
