package md_tmpl

/*
#include <stdlib.h>
#include <stdint.h>
#include <stdbool.h>

extern void pt_free_string(char *ptr);

// Context lifecycle.
extern void *pt_context_new(void);
extern void pt_context_free(void *ctx);
extern char *pt_context_set_str(void *ctx, const char *key, const char *value);
extern char *pt_context_set_int(void *ctx, const char *key, int64_t value);
extern char *pt_context_set_float(void *ctx, const char *key, double value);
extern char *pt_context_set_bool(void *ctx, const char *key, _Bool value);
extern char *pt_context_set_none(void *ctx, const char *key);
extern char *pt_context_set_json(void *ctx, const char *key, const char *json_str);
extern char *pt_context_merge_json(void *ctx, const char *json_str);
extern char *pt_context_set_tmpl(void *ctx, const char *key, void *tmpl);
extern char *pt_context_set_flexbuffers(void *ctx, const char *key, const uint8_t *data, size_t len);

// Cache lifecycle.
extern char *pt_context_merge_flexbuffers(void *ctx, const uint8_t *data, size_t len);
extern void *pt_cache_new(void);
extern void pt_cache_free(void *cache);
extern char *pt_cache_load(const void *cache, const char *path, void **out);
extern void pt_cache_clear(const void *cache);
extern size_t pt_cache_template_count(const void *cache);
extern size_t pt_cache_include_count(const void *cache);
*/
import "C"

import (
	"errors"
	"fmt"
	"runtime"
	"unsafe"
)

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

// NewContext creates a new empty rendering context.
//
// Close must be called when the context is no longer needed.
func NewContext() *Context {
	ctx := &Context{ptr: C.pt_context_new()}
	runtime.SetFinalizer(ctx, func(c *Context) { c.Close() })
	return ctx
}

// Close frees the context resources. Safe to call multiple times and
// concurrently. Implements [io.Closer].
func (c *Context) Close() error {
	c.closeOnce.Do(func() {
		if c.ptr != nil {
			C.pt_context_free(c.ptr)
			c.ptr = nil
		}
	})
	return nil
}

// SetStr sets a string value in the context.
func (c *Context) SetStr(key, value string) error {
	if c.ptr == nil {
		return ErrClosed
	}
	cKey := C.CString(key)
	defer C.free(unsafe.Pointer(cKey))
	cVal := C.CString(value)
	defer C.free(unsafe.Pointer(cVal))

	errPtr := C.pt_context_set_str(c.ptr, cKey, cVal)
	return freeError(errPtr)
}

// SetInt sets an integer value in the context.
func (c *Context) SetInt(key string, value int64) error {
	if c.ptr == nil {
		return ErrClosed
	}
	cKey := C.CString(key)
	defer C.free(unsafe.Pointer(cKey))

	errPtr := C.pt_context_set_int(c.ptr, cKey, C.int64_t(value))
	return freeError(errPtr)
}

// SetFloat sets a float value in the context.
func (c *Context) SetFloat(key string, value float64) error {
	if c.ptr == nil {
		return ErrClosed
	}
	cKey := C.CString(key)
	defer C.free(unsafe.Pointer(cKey))

	errPtr := C.pt_context_set_float(c.ptr, cKey, C.double(value))
	return freeError(errPtr)
}

// SetBool sets a bool value in the context.
func (c *Context) SetBool(key string, value bool) error {
	if c.ptr == nil {
		return ErrClosed
	}
	cKey := C.CString(key)
	defer C.free(unsafe.Pointer(cKey))

	errPtr := C.pt_context_set_bool(c.ptr, cKey, C._Bool(value))
	return freeError(errPtr)
}

// SetNone sets a None (absent) value in the context.
//
// Use this for option(T) parameters to indicate an absent value.
// Equivalent to passing null/nil.
func (c *Context) SetNone(key string) error {
	if c.ptr == nil {
		return ErrClosed
	}
	cKey := C.CString(key)
	defer C.free(unsafe.Pointer(cKey))

	errPtr := C.pt_context_set_none(c.ptr, cKey)
	return freeError(errPtr)
}

// SetJSON sets a complex value (list, struct, enum) in the context from a JSON string.
//
// Example:
//
//	ctx.SetJSON("items", `[{"label":"alpha"},{"label":"beta"}]`)
func (c *Context) SetJSON(key, jsonStr string) error {
	if c.ptr == nil {
		return ErrClosed
	}
	cKey := C.CString(key)
	defer C.free(unsafe.Pointer(cKey))
	cJSON := C.CString(jsonStr)
	defer C.free(unsafe.Pointer(cJSON))

	errPtr := C.pt_context_set_json(c.ptr, cKey, cJSON)
	return freeError(errPtr)
}

// MergeJSON merges all top-level keys from a JSON object into the context.
//
// The JSON string must be a JSON object. Each key becomes a context variable.
// This is more efficient than calling [Set] in a loop because it crosses the
// FFI boundary only once.
//
// Example:
//
//	ctx.MergeJSON(`{"name": "Alice", "count": 42}`)
func (c *Context) MergeJSON(jsonStr string) error {
	if c.ptr == nil {
		return ErrClosed
	}
	cJSON := C.CString(jsonStr)
	defer C.free(unsafe.Pointer(cJSON))

	errPtr := C.pt_context_merge_json(c.ptr, cJSON)
	return freeError(errPtr)
}

// MergeStruct merges all exported struct fields into the context via FlexBuffers.
//
// Struct fields are mapped to context variables by their json tag name,
// falling back to the lowercased field name. Unexported fields are skipped.
//
// Example:
//
//	ctx.MergeStruct(Params{Name: "Alice", Count: 42})
func (c *Context) MergeStruct(v any) error {
	if c.ptr == nil {
		return ErrClosed
	}
	data, err := marshalFlexbuffers(v)
	if err != nil {
		return fmt.Errorf("MergeStruct: cannot marshal to flexbuffers: %w", err)
	}
	if len(data) == 0 {
		return errors.New("md_tmpl: MergeStruct: empty flexbuffers data")
	}

	errPtr := C.pt_context_merge_flexbuffers(c.ptr, (*C.uint8_t)(&data[0]), C.size_t(len(data)))
	return freeError(errPtr)
}

// MergeMap merges all map keys into the context via FlexBuffers.
func (c *Context) MergeMap(params map[string]any) error {
	if c.ptr == nil {
		return ErrClosed
	}
	data, err := marshalFlexbuffers(params)
	if err != nil {
		return fmt.Errorf("MergeMap: cannot marshal to flexbuffers: %w", err)
	}
	if len(data) == 0 {
		return errors.New("md_tmpl: MergeMap: empty flexbuffers data")
	}

	errPtr := C.pt_context_merge_flexbuffers(c.ptr, (*C.uint8_t)(&data[0]), C.size_t(len(data)))
	return freeError(errPtr)
}

// SetTmpl sets a template-typed parameter in the context.
//
// This is used for tmpl(...) parameters, where one template is passed as a
// parameter to another template. The template is shared via Arc — the caller
// retains ownership of the original.
func (c *Context) SetTmpl(key string, tmpl *Template) error {
	if c.ptr == nil {
		return ErrClosed
	}
	if tmpl == nil || tmpl.ptr == nil {
		return ErrClosed
	}
	cKey := C.CString(key)
	defer C.free(unsafe.Pointer(cKey))

	errPtr := C.pt_context_set_tmpl(c.ptr, cKey, tmpl.ptr)
	return freeError(errPtr)
}

// Set sets a value in the context, automatically choosing the right type.
//
// Supported types:
//   - nil → SetNone (absent option value)
//   - string → SetStr
//   - int, int64 → SetInt
//   - float64 → SetFloat
//   - bool → SetBool
//   - *Template → SetTmpl
//   - []any, map[string]any, structs → SetFlexbuffers (via binary encoding)
//   - anything else → SetFlexbuffers (via binary encoding)
func (c *Context) Set(key string, value any) error {
	if c.ptr == nil {
		return ErrClosed
	}
	if value == nil {
		return c.SetNone(key)
	}
	switch v := value.(type) {
	case string:
		return c.SetStr(key, v)
	case int:
		return c.SetInt(key, int64(v))
	case int8:
		return c.SetInt(key, int64(v))
	case int16:
		return c.SetInt(key, int64(v))
	case int32:
		return c.SetInt(key, int64(v))
	case int64:
		return c.SetInt(key, v)
	case uint:
		return c.SetInt(key, int64(v))
	case uint8:
		return c.SetInt(key, int64(v))
	case uint16:
		return c.SetInt(key, int64(v))
	case uint32:
		return c.SetInt(key, int64(v))
	case uint64:
		return c.SetInt(key, int64(v))
	case float64:
		return c.SetFloat(key, v)
	case float32:
		return c.SetFloat(key, float64(v))
	case bool:
		return c.SetBool(key, v)
	case *Template:
		return c.SetTmpl(key, v)
	case Variant:
		if len(v.Fields) == 0 {
			// Unit variant → set as string directly.
			return c.SetStr(key, v.Kind)
		}
		// Struct variant → fall through to FlexBuffers path.
		return c.setFlexbuffers(key, v)
	default:
		return c.setFlexbuffers(key, v)
	}
}

// setFlexbuffers marshals any value to FlexBuffers and sets it in the context.
func (c *Context) setFlexbuffers(key string, v any) error {
	data, err := marshalFlexbuffers(v)
	if err != nil {
		return fmt.Errorf("cannot marshal %T to flexbuffers: %w", v, err)
	}
	cKey := C.CString(key)
	defer C.free(unsafe.Pointer(cKey))
	errPtr := C.pt_context_set_flexbuffers(c.ptr, cKey, (*C.uint8_t)(&data[0]), C.size_t(len(data)))
	return freeError(errPtr)
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

// NewCache creates a new empty template cache.
//
// Close must be called when the cache is no longer needed.
func NewCache() *Cache {
	cache := &Cache{ptr: C.pt_cache_new()}
	runtime.SetFinalizer(cache, func(c *Cache) { c.Close() })
	return cache
}

// Close frees the cache resources. Safe to call multiple times and
// concurrently. Implements [io.Closer].
func (c *Cache) Close() error {
	c.closeOnce.Do(func() {
		if c.ptr != nil {
			C.pt_cache_free(c.ptr)
			c.ptr = nil
		}
	})
	return nil
}

// Load loads a template through the cache. Unchanged files return cached
// compilations with zero re-parsing.
func (c *Cache) Load(path string) (*Template, error) {
	if c.ptr == nil {
		return nil, ErrClosed
	}

	cPath := C.CString(path)
	defer C.free(unsafe.Pointer(cPath))

	var ptr unsafe.Pointer
	errPtr := C.pt_cache_load(c.ptr, cPath, &ptr)
	if err := freeError(errPtr); err != nil {
		return nil, err
	}

	t := &Template{ptr: ptr}
	runtime.SetFinalizer(t, func(t *Template) { t.Close() })
	return t, nil
}

// Clear invalidates all cached entries.
func (c *Cache) Clear() {
	if c.ptr != nil {
		C.pt_cache_clear(c.ptr)
	}
}

// TemplateCount returns the number of cached main templates.
func (c *Cache) TemplateCount() int {
	if c.ptr == nil {
		return 0
	}
	return int(C.pt_cache_template_count(c.ptr))
}

// IncludeCount returns the number of cached include templates.
func (c *Cache) IncludeCount() int {
	if c.ptr == nil {
		return 0
	}
	return int(C.pt_cache_include_count(c.ptr))
}
