//! Tells the web layer where iOS wants app bars.
//!
//! On iPhone Duo the system moves tab bars and toolbars into a vertical strip on
//! the outer display and in inner-display landscape, keeping horizontal bars
//! only in inner-display portrait. Apple asks apps to follow
//! `UITraitCollection.verticalBarEdge` rather than the device model or screen
//! size. Our tab bar is drawn by the web page, so the native side reads that
//! trait (and the horizontal size class) and hands them to the page.

use serde::Serialize;
use std::sync::atomic::{AtomicIsize, Ordering};

pub const BAR_LAYOUT_EVENT: &str = "bar-layout";

// UIVerticalBarEdge: 0 unspecified, 1 leading, 2 trailing.
static VERTICAL_BAR_EDGE: AtomicIsize = AtomicIsize::new(0);
// UIUserInterfaceSizeClass: 0 unspecified, 1 compact, 2 regular.
static HORIZONTAL_SIZE_CLASS: AtomicIsize = AtomicIsize::new(0);

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BarLayout {
    /// `leading`, `trailing`, or `none` when the system keeps bars horizontal.
    pub vertical_bar_edge: &'static str,
    /// `compact`, `regular`, or `unspecified`.
    pub horizontal_size_class: &'static str,
}

fn describe(edge: isize, size_class: isize) -> BarLayout {
    BarLayout {
        vertical_bar_edge: match edge {
            1 => "leading",
            2 => "trailing",
            _ => "none",
        },
        horizontal_size_class: match size_class {
            1 => "compact",
            2 => "regular",
            _ => "unspecified",
        },
    }
}

fn current() -> BarLayout {
    describe(
        VERTICAL_BAR_EDGE.load(Ordering::Relaxed),
        HORIZONTAL_SIZE_CLASS.load(Ordering::Relaxed),
    )
}

#[tauri::command]
pub fn bar_layout() -> BarLayout {
    current()
}

/// Reads the web view's traits now and again whenever the ones that move the
/// vertical bar change, emitting `bar-layout` to the page each time.
#[cfg(target_os = "ios")]
pub fn observe(app: tauri::AppHandle, wk_webview: *mut std::ffi::c_void) {
    use block2::RcBlock;
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2::{msg_send, sel};
    use tauri::Emitter;

    unsafe fn store(view: *mut AnyObject) -> bool {
        let traits: *mut AnyObject = msg_send![view, traitCollection];
        if traits.is_null() {
            return false;
        }
        let has_edge: Bool = msg_send![traits, respondsToSelector: sel!(verticalBarEdge)];
        let edge: isize = if has_edge.as_bool() {
            msg_send![traits, verticalBarEdge]
        } else {
            0
        };
        let size_class: isize = msg_send![traits, horizontalSizeClass];
        let edge_changed = VERTICAL_BAR_EDGE.swap(edge, Ordering::Relaxed) != edge;
        let size_changed = HORIZONTAL_SIZE_CLASS.swap(size_class, Ordering::Relaxed) != size_class;
        edge_changed || size_changed
    }

    let view = wk_webview as *mut AnyObject;
    unsafe {
        store(view);

        let Some(collection) = AnyClass::get(c"UITraitCollection") else {
            return;
        };
        // Older iOS has no vertical bar; the size class alone still matters there.
        let mut traits: *mut AnyObject = std::ptr::null_mut();
        let has_bar_traits: Bool =
            msg_send![collection, respondsToSelector: sel!(systemTraitsAffectingVerticalBarEdge)];
        if has_bar_traits.as_bool() {
            traits = msg_send![collection, systemTraitsAffectingVerticalBarEdge];
        }
        let Some(size_class_trait) = AnyClass::get(c"UITraitHorizontalSizeClass") else {
            return;
        };
        // Trait classes go into the array as plain objects.
        let size_class_trait = size_class_trait as *const AnyClass as *mut AnyObject;
        traits = if traits.is_null() {
            msg_send![AnyClass::get(c"NSArray").unwrap(), arrayWithObject: size_class_trait]
        } else {
            msg_send![traits, arrayByAddingObject: size_class_trait]
        };

        let handler = RcBlock::new(
            move |environment: *mut AnyObject, _previous: *mut AnyObject| {
                if store(environment) {
                    let _ = app.emit(BAR_LAYOUT_EVENT, current());
                }
            },
        );
        let _registration: *mut AnyObject =
            msg_send![view, registerForTraitChanges: traits, withHandler: &*handler];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_uikit_values() {
        assert_eq!(
            describe(2, 1),
            BarLayout {
                vertical_bar_edge: "trailing",
                horizontal_size_class: "compact"
            }
        );
        assert_eq!(
            describe(1, 2),
            BarLayout {
                vertical_bar_edge: "leading",
                horizontal_size_class: "regular"
            }
        );
        assert_eq!(
            describe(0, 0),
            BarLayout {
                vertical_bar_edge: "none",
                horizontal_size_class: "unspecified"
            }
        );
    }
}
