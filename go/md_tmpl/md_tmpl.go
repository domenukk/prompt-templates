// Package md_tmpl provides a fast, strongly-typed template engine
// for LLM prompts from Go.
//
// Templates use a declarative YAML frontmatter with typed parameters
// (str, int, float, bool, list, struct, enum, tmpl) and a Jinja2-inspired
// body with for-loops, match/case, filters, includes, and constants.
//
// # Quick Start
//
//	source := `---
//	params:
//	  - name = str
//	---
//	Hello {{ name }}!`
//	tmpl, err := md_tmpl.FromSource(source)
//	if err != nil {
//	    log.Fatal(err)
//	}
//	defer tmpl.Close()
//
//	result, _ := tmpl.RenderMap(map[string]any{"name": "world"})
//	// result == "Hello world!"
//
// # Building
//
// Build the native library before using this package:
//
//	just build-go-ffi
package md_tmpl

/*
#cgo LDFLAGS: -L${SRCDIR}/../../target/release -lmd_tmpl_ffi -ldl -lpthread -lm
#cgo CFLAGS: -I${SRCDIR}/../../crates/md-tmpl-ffi/include

#include <stdlib.h>
#include <stdint.h>
#include <stdbool.h>

// String lifecycle.
extern void pt_free_string(char *ptr);

// Template lifecycle.
extern char *pt_template_from_source(const char *source, void **out);
extern char *pt_template_from_source_with_options(const char *source, const char *base_dir, const char *env_json, _Bool allow_unused, void **out);
extern char *pt_template_from_file(const char *path, void **out);
extern char *pt_template_from_file_with_options(const char *path, const char *base_dir, const char *env_json, _Bool allow_unused, void **out);
extern void pt_template_free(void *tmpl);

// Context lifecycle.
extern void *pt_context_new(void);
extern void pt_context_free(void *ctx);
extern char *pt_context_set_str(void *ctx, const char *key, const char *value);
extern char *pt_context_set_int(void *ctx, const char *key, int64_t value);
extern char *pt_context_set_float(void *ctx, const char *key, double value);
extern char *pt_context_set_bool(void *ctx, const char *key, _Bool value);
extern char *pt_context_set_none(void *ctx, const char *key);
extern char *pt_context_set_json(void *ctx, const char *key, const char *json);
extern char *pt_context_set_tmpl(void *ctx, const char *key, const void *tmpl);
extern char *pt_context_merge_json(void *ctx, const char *json);
extern char *pt_context_set_flexbuffers(void *ctx, const char *key, const uint8_t *data, size_t len);
extern char *pt_context_merge_flexbuffers(void *ctx, const uint8_t *data, size_t len);

// Rendering.
extern char *pt_template_render(const void *tmpl, const void *ctx, char **out_err);
extern char *pt_template_render_allowing_extra(const void *tmpl, const void *ctx, char **out_err);
extern char *pt_template_render_empty(const void *tmpl, char **out_err);
extern char *pt_template_render_unchecked(const void *tmpl, const void *ctx, char **out_err);
extern char *pt_template_render_cached(const void *tmpl, const void *ctx, const void *cache, char **out_err);
extern char *pt_template_render_json(const void *tmpl, const char *json, _Bool allow_extra, char **out_err);
extern char *pt_template_render_flexbuffers(const void *tmpl, const uint8_t *data, size_t len, _Bool allow_extra, char **out_err);

// Template metadata.
extern uint64_t pt_template_source_hash(const void *tmpl);
extern char *pt_template_name(const void *tmpl);
extern char *pt_template_description(const void *tmpl);
extern char *pt_template_body(const void *tmpl);
extern char *pt_template_declarations(const void *tmpl);
extern void pt_template_set_max_include_depth(void *tmpl, size_t depth);
extern char *pt_template_defaults_json(const void *tmpl);
extern char *pt_template_consts_json(const void *tmpl);
extern char *pt_template_imported_consts_json(const void *tmpl);
extern void *pt_template_defaults_context(const void *tmpl);
extern char *pt_template_validate_declarations(const void *tmpl, const char *expected_json);
extern char *pt_template_from_source_with_frontmatter(const char *source, void **out_tmpl, char **out_fm);

// Cache lifecycle.
extern void *pt_cache_new(void);
extern void pt_cache_free(void *cache);
extern char *pt_cache_load(const void *cache, const char *path, void **out);
extern void pt_cache_clear(const void *cache);
extern size_t pt_cache_template_count(const void *cache);
extern size_t pt_cache_include_count(const void *cache);
*/
import "C"

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"runtime"
	"strings"
	"sync"
	"unsafe"
)

// Compile-time interface checks.
var (
	_ io.Closer = (*Template)(nil)
	_ io.Closer = (*Context)(nil)
	_ io.Closer = (*Cache)(nil)
)

// debugLog is a package-level logger for non-critical internal errors
// (e.g. JSON parse failures in metadata methods). It defaults to discarding
// output. Enable it by setting debugLog.SetOutput(os.Stderr) or similar.
var debugLog = log.New(io.Discard, "md_tmpl: ", log.LstdFlags)

// Sentinel errors returned by the package.
var (
	// ErrClosed is returned when operating on a Template, Context, or Cache
	// that has already been closed.
	ErrClosed = errors.New("md_tmpl: resource is closed")

	// ErrNilContext is returned when a nil or closed Context is passed to Render.
	ErrNilContext = errors.New("md_tmpl: context is nil or closed")
)

// ErrorKind is a stable, machine-readable classification of an engine error.
//
// The values mirror md_tmpl::ErrorKind on the Rust side and are stable across
// releases, so they are safe to switch on or compare against.
type ErrorKind string

// Known error kinds. These match the stable ids emitted by the core engine.
const (
	KindIO                  ErrorKind = "io"
	KindUndefinedVariable   ErrorKind = "undefined_variable"
	KindSyntax              ErrorKind = "syntax"
	KindMissingParams       ErrorKind = "missing_params"
	KindTypeMismatch        ErrorKind = "type_mismatch"
	KindUnknownFilter       ErrorKind = "unknown_filter"
	KindIncludeNotFound     ErrorKind = "include_not_found"
	KindDeclarationsMutated ErrorKind = "declarations_mutated"
	KindExtraParams         ErrorKind = "extra_params"
	KindPanic               ErrorKind = "panic"
	// KindUnknown is used when the engine returns an error without a
	// recognizable kind prefix (e.g. errors originating in the FFI shim).
	KindUnknown ErrorKind = ""
)

// TemplateError is a structured error returned by the template engine.
//
// It carries a machine-readable [ErrorKind] alongside the human-readable
// message. Match specific kinds with [errors.Is] against the package
// sentinels (e.g. [ErrMissingParams]) or inspect Kind directly.
type TemplateError struct {
	Kind    ErrorKind
	Message string
}

// Error implements the error interface.
func (e *TemplateError) Error() string { return e.Message }

// Is reports whether target is a *TemplateError of the same kind, enabling
// errors.Is(err, ErrMissingParams) style matching.
func (e *TemplateError) Is(target error) bool {
	t, ok := target.(*TemplateError)
	return ok && t.Kind == e.Kind
}

// Per-kind sentinels for use with errors.Is.
var (
	ErrIO                  = &TemplateError{Kind: KindIO}
	ErrUndefinedVariable   = &TemplateError{Kind: KindUndefinedVariable}
	ErrSyntax              = &TemplateError{Kind: KindSyntax}
	ErrMissingParams       = &TemplateError{Kind: KindMissingParams}
	ErrTypeMismatch        = &TemplateError{Kind: KindTypeMismatch}
	ErrUnknownFilter       = &TemplateError{Kind: KindUnknownFilter}
	ErrIncludeNotFound     = &TemplateError{Kind: KindIncludeNotFound}
	ErrDeclarationsMutated = &TemplateError{Kind: KindDeclarationsMutated}
	ErrExtraParams         = &TemplateError{Kind: KindExtraParams}
	ErrPanic               = &TemplateError{Kind: KindPanic}
)

// errKindSep is the ASCII Unit Separator (U+001F) the FFI uses to delimit the
// stable error kind from the human-readable message: "<kind>\x1f<message>".
const errKindSep = "\x1f"

// Template is a parsed, validated template ready for rendering.
//
// Templates are compiled from source strings or loaded from files.
// Parameters are type-checked against frontmatter declarations at render time.
//
// Template is safe for concurrent use from multiple goroutines after creation.
//
// Close must be called when the template is no longer needed.
type Template struct {
	ptr       unsafe.Pointer
	closeOnce sync.Once
}

// Context holds the variables available during template rendering.
//
// Context is NOT safe for concurrent use. Each goroutine should create its own Context.
//
// Close must be called when the context is no longer needed.
type Context struct {
	ptr       unsafe.Pointer
	closeOnce sync.Once
}

// Cache provides content-hashed template caching for hot-reload scenarios.
//
// Unchanged files return cached compilations with zero re-parsing.
// Cache is safe for concurrent use from multiple goroutines.
//
// Close must be called when the cache is no longer needed.
type Cache struct {
	ptr       unsafe.Pointer
	closeOnce sync.Once
}

// Declaration represents a single parameter declaration from frontmatter.
type Declaration struct {
	Name    string // Parameter name.
	Type    string // Parameter type (e.g. "str", "int", "list(label = str)").
	Default any    // Default value (nil if no default).
}

// String returns the declaration in "name = type" format.
func (d Declaration) String() string {
	return d.Name + " = " + d.Type
}

// Frontmatter holds parsed metadata from the template's YAML frontmatter block.
type Frontmatter struct {
	Name        string   // Template name.
	Description string   // Template description.
	HasParams   bool     // Whether a params: block was present.
	AllowUnused bool     // Whether unused parameters are allowed.
	Params      []string // Parameter names (convenience).
}

// TaggedVariant is an embeddable base struct for creating statically typed,
// zero-allocation enum variants in Go without using maps or magic strings.
//
// By embedding TaggedVariant in your custom structs, you get static
// typing for template enum variants that mirrors Rust's enum representation.
//
// Example:
//
//	type Confirmed struct {
//	    md_tmpl.TaggedVariant
//	    Evidence string `json:"evidence"`
//	}
//
//	func NewConfirmed(evidence string) Confirmed {
//	    return Confirmed{TaggedVariant: md_tmpl.NewTaggedVariant("Confirmed"), Evidence: evidence}
//	}
type TaggedVariant struct {
	Kind string `json:"__kind__"`
}

// NewTaggedVariant creates a new TaggedVariant with the given enum variant name.
func NewTaggedVariant(kind string) TaggedVariant {
	return TaggedVariant{Kind: kind}
}

// Variant represents a dynamic template enum variant.
//
// For static type safety without map allocations, embed [TaggedVariant] instead.
//
// Unit variants (no fields):
//
//	Variant{Kind: "Rejected"}
//
// Struct variants (with fields):
//
//	Variant{Kind: "Confirmed", Fields: map[string]any{"evidence": "found it"}}
type Variant struct {
	Kind   string         // The variant name.
	Fields map[string]any // Optional fields for struct variants.
}

// MarshalJSON encodes the variant using the __kind__ tag convention.
func (v Variant) MarshalJSON() ([]byte, error) {
	if len(v.Fields) == 0 {
		// Unit variant → plain string.
		return json.Marshal(v.Kind)
	}
	// Struct variant → {"__kind__": "Kind", ...fields}
	m := make(map[string]any, len(v.Fields)+1)
	m["__kind__"] = v.Kind
	for k, val := range v.Fields {
		m[k] = val
	}
	return json.Marshal(m)
}

// VariantMarshaler is implemented by statically-typed enum variant types (such
// as those emitted by the code generator) to expose their dynamic,
// __kind__-tagged representation.
//
// It lets the FlexBuffers and JSON encoders serialize a concrete variant using
// the shared cross-language wire format — a bare string for unit variants, or a
// {"__kind__": "...", ...fields} object for data variants — without the
// encoder needing to know the concrete type. Generated code implements this;
// you rarely call it directly.
type VariantMarshaler interface {
	AsVariant() Variant
}

// VariantKind extracts the discriminant name from a variant's JSON encoding.
//
// It accepts both wire forms: a bare JSON string (a unit variant, e.g.
// "Rejected") and an object carrying a "__kind__" field (a data variant, e.g.
// {"__kind__":"Confirmed","evidence":"x"}). Generated UnmarshalX dispatchers
// use it to decide which concrete variant to decode into.
func VariantKind(data []byte) (string, error) {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 {
		return "", errors.New("md_tmpl: empty variant JSON")
	}
	if trimmed[0] == '"' {
		var name string
		if err := json.Unmarshal(trimmed, &name); err != nil {
			return "", fmt.Errorf("md_tmpl: decoding unit variant: %w", err)
		}
		return name, nil
	}
	var probe struct {
		Kind string `json:"__kind__"`
	}
	if err := json.Unmarshal(trimmed, &probe); err != nil {
		return "", fmt.Errorf("md_tmpl: decoding data variant: %w", err)
	}
	if probe.Kind == "" {
		return "", errors.New("md_tmpl: variant object missing __kind__")
	}
	return probe.Kind, nil
}

// freeError converts a C error string to a Go error and frees the C string.
// Returns nil if errPtr is nil (no error).
//
// The FFI encodes errors as "<kind>\x1f<message>". When the separator is
// present the result is a [*TemplateError] carrying the stable [ErrorKind];
// otherwise a plain error with the raw message is returned.
func freeError(errPtr *C.char) error {
	if errPtr == nil {
		return nil
	}
	msg := C.GoString(errPtr)
	C.pt_free_string(errPtr)
	return parseError(msg)
}

// parseError splits a transported error string into a typed error.
func parseError(raw string) error {
	if raw == "" {
		return nil
	}
	if kind, message, found := strings.Cut(raw, errKindSep); found {
		return &TemplateError{Kind: ErrorKind(kind), Message: message}
	}
	// No kind prefix (e.g. an error from the FFI shim itself).
	return errors.New(raw)
}

// ---------------------------------------------------------------------------
// Template constructors
// ---------------------------------------------------------------------------

// Option configures how a template is compiled by [FromSource] and [FromFile].
//
// Options compose freely, e.g.:
//
//	tmpl, err := md_tmpl.FromSource(src,
//	    md_tmpl.WithBaseDir("/prompts"),
//	    md_tmpl.WithEnv(map[string]any{"MAX_RETRIES": 5}),
//	    md_tmpl.WithAllowUnused(),
//	)
type Option func(*compileOptions)

// compileOptions accumulates the effect of the applied [Option] values.
type compileOptions struct {
	baseDir     string
	env         map[string]any
	hasEnv      bool
	allowUnused bool
}

// WithBaseDir resolves {% include %} and imports: directives relative to dir.
func WithBaseDir(dir string) Option {
	return func(o *compileOptions) { o.baseDir = dir }
}

// WithEnv supplies compile-time environment variables.
//
// Values are resolved against `env:` declarations in the frontmatter, typed,
// and serialized as JSON to the engine. Passing WithEnv(nil) is valid and
// means "no environment values", which still satisfies env declarations that
// provide defaults.
func WithEnv(env map[string]any) Option {
	return func(o *compileOptions) {
		o.env = env
		o.hasEnv = true
	}
}

// WithAllowUnused permits declared parameters that are not referenced in the
// template body (rejected by default).
func WithAllowUnused() Option {
	return func(o *compileOptions) { o.allowUnused = true }
}

// applyOptions folds opts into a compileOptions value.
func applyOptions(opts []Option) compileOptions {
	var co compileOptions
	for _, opt := range opts {
		opt(&co)
	}
	return co
}

// cBaseDir returns a C string for the base dir (or nil), plus a cleanup func.
// The cleanup func must always be called.
func (co compileOptions) cBaseDir() (*C.char, func()) {
	if co.baseDir == "" {
		return nil, func() {}
	}
	c := C.CString(co.baseDir)
	return c, func() { C.free(unsafe.Pointer(c)) }
}

// cEnvJSON marshals the env map to a C JSON string (or nil), plus a cleanup
// func. The cleanup func must always be called. A nil env map is encoded as an
// empty JSON object ("{}") rather than "null", so WithEnv(nil) resolves env
// declarations purely from their defaults.
func (co compileOptions) cEnvJSON() (*C.char, func(), error) {
	if !co.hasEnv {
		return nil, func() {}, nil
	}
	env := co.env
	if env == nil {
		env = map[string]any{}
	}
	envJSON, err := json.Marshal(env)
	if err != nil {
		return nil, func() {}, fmt.Errorf("cannot marshal env: %w", err)
	}
	c := C.CString(string(envJSON))
	return c, func() { C.free(unsafe.Pointer(c)) }, nil
}

// newTemplate wraps a raw FFI pointer in a finalized *Template.
func newTemplate(ptr unsafe.Pointer) *Template {
	t := &Template{ptr: ptr}
	runtime.SetFinalizer(t, func(t *Template) { t.Close() })
	return t
}

// FromSource parses a template from an in-memory source string.
//
// The source must include YAML frontmatter with parameter declarations.
// Unused declared parameters (present in frontmatter but not in the body)
// are rejected unless [WithAllowUnused] is supplied. Includes are resolved
// relative to the directory given by [WithBaseDir], and compile-time
// environment values may be supplied with [WithEnv].
func FromSource(source string, opts ...Option) (*Template, error) {
	co := applyOptions(opts)

	cSource := C.CString(source)
	defer C.free(unsafe.Pointer(cSource))

	cDir, freeDir := co.cBaseDir()
	defer freeDir()
	cEnv, freeEnv, err := co.cEnvJSON()
	if err != nil {
		return nil, err
	}
	defer freeEnv()

	var ptr unsafe.Pointer
	errPtr := C.pt_template_from_source_with_options(cSource, cDir, cEnv, C._Bool(co.allowUnused), &ptr)
	if err := freeError(errPtr); err != nil {
		return nil, err
	}
	return newTemplate(ptr), nil
}

// FromSourceAllowingUnused parses a template, allowing declared parameters
// that aren't referenced in the body.
//
// It is shorthand for FromSource(source, WithAllowUnused()).
func FromSourceAllowingUnused(source string) (*Template, error) {
	return FromSource(source, WithAllowUnused())
}

// FromSourceWithBaseDir parses a template from source, resolving includes
// relative to the given base directory.
//
// It is shorthand for FromSource(source, WithBaseDir(baseDir)).
func FromSourceWithBaseDir(source, baseDir string) (*Template, error) {
	return FromSource(source, WithBaseDir(baseDir))
}

// FromSourceWithEnv parses a template with compile-time environment variables.
//
// It is shorthand for FromSource(source, WithEnv(env)).
func FromSourceWithEnv(source string, env map[string]any) (*Template, error) {
	return FromSource(source, WithEnv(env))
}

// FromSourceWithFrontmatter parses a template and returns both the compiled
// template and its parsed frontmatter metadata.
//
// Use this to access the template's name, description, and other metadata
// from the YAML frontmatter block.
func FromSourceWithFrontmatter(source string) (*Template, *Frontmatter, error) {
	cSource := C.CString(source)
	defer C.free(unsafe.Pointer(cSource))

	var tmplPtr unsafe.Pointer
	var fmPtr *C.char
	errPtr := C.pt_template_from_source_with_frontmatter(cSource, &tmplPtr, &fmPtr)
	if err := freeError(errPtr); err != nil {
		return nil, nil, err
	}

	t := &Template{ptr: tmplPtr}
	runtime.SetFinalizer(t, func(t *Template) { t.Close() })

	// Parse frontmatter JSON.
	fmJSON := C.GoString(fmPtr)
	C.pt_free_string(fmPtr)

	var raw struct {
		Name        string   `json:"name"`
		Description string   `json:"description"`
		HasParams   bool     `json:"has_params"`
		AllowUnused bool     `json:"allow_unused"`
		Params      []string `json:"params"`
	}
	if err := json.Unmarshal([]byte(fmJSON), &raw); err != nil {
		return t, nil, fmt.Errorf("parsing frontmatter JSON: %w", err)
	}

	fm := &Frontmatter{
		Name:        raw.Name,
		Description: raw.Description,
		HasParams:   raw.HasParams,
		AllowUnused: raw.AllowUnused,
		Params:      raw.Params,
	}
	return t, fm, nil
}

// FromFile loads a template from a .tmpl.md file.
//
// The same compile [Option] values accepted by [FromSource] apply here. When
// [WithBaseDir] is omitted, includes are resolved relative to the file's own
// parent directory.
func FromFile(path string, opts ...Option) (*Template, error) {
	co := applyOptions(opts)

	cPath := C.CString(path)
	defer C.free(unsafe.Pointer(cPath))

	cDir, freeDir := co.cBaseDir()
	defer freeDir()
	cEnv, freeEnv, err := co.cEnvJSON()
	if err != nil {
		return nil, err
	}
	defer freeEnv()

	var ptr unsafe.Pointer
	errPtr := C.pt_template_from_file_with_options(cPath, cDir, cEnv, C._Bool(co.allowUnused), &ptr)
	if err := freeError(errPtr); err != nil {
		return nil, err
	}
	return newTemplate(ptr), nil
}

// Close frees the template resources. Safe to call multiple times and
// concurrently. Implements [io.Closer].
func (t *Template) Close() error {
	t.closeOnce.Do(func() {
		if t.ptr != nil {
			C.pt_template_free(t.ptr)
			t.ptr = nil
		}
	})
	return nil
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

// RenderOption configures a single render call.
//
// Options are applied left-to-right; the empty set renders in strict mode.
// The same options apply to every render form ([Template.Render],
// [Template.RenderMap], [Template.RenderJSON], [Template.RenderStruct]).
type RenderOption func(*renderConfig)

// renderConfig holds the resolved settings for a single render call.
type renderConfig struct {
	allowExtra bool
}

// resolveRenderConfig folds the supplied options into a renderConfig.
func resolveRenderConfig(opts []RenderOption) renderConfig {
	var cfg renderConfig
	for _, opt := range opts {
		opt(&cfg)
	}
	return cfg
}

// AllowExtra permits context keys that are not declared in the template
// frontmatter.
//
// Without it, rendering is strict: an undeclared parameter yields an
// ExtraParams [TemplateError]. This single option replaces the former
// family of dedicated *AllowingExtra render methods.
func AllowExtra() RenderOption {
	return func(c *renderConfig) { c.allowExtra = true }
}

// Render renders the template with the given context (strict mode by default).
//
// All parameters are validated against frontmatter declarations. Missing
// parameters, type mismatches, and extra undeclared parameters produce typed
// errors (see [TemplateError]). Pass [AllowExtra] to permit undeclared
// parameters instead of erroring.
func (t *Template) Render(ctx *Context, opts ...RenderOption) (string, error) {
	if t.ptr == nil {
		return "", ErrClosed
	}
	if ctx == nil || ctx.ptr == nil {
		return "", ErrNilContext
	}

	var errPtr *C.char
	var result *C.char
	if resolveRenderConfig(opts).allowExtra {
		result = C.pt_template_render_allowing_extra(t.ptr, ctx.ptr, &errPtr)
	} else {
		result = C.pt_template_render(t.ptr, ctx.ptr, &errPtr)
	}
	if errPtr != nil {
		return "", freeError(errPtr)
	}
	if result == nil {
		return "", errors.New("md_tmpl: render returned nil without error")
	}

	output := C.GoString(result)
	C.pt_free_string(result)
	return output, nil
}

// RenderEmpty renders the template with an empty context.
//
// This is a convenience for templates whose parameters all have defaults (or
// that declare no parameters). Any parameter without a default still produces
// a missing-parameter error.
func (t *Template) RenderEmpty() (string, error) {
	if t.ptr == nil {
		return "", ErrClosed
	}

	var errPtr *C.char
	result := C.pt_template_render_empty(t.ptr, &errPtr)
	if errPtr != nil {
		return "", freeError(errPtr)
	}
	if result == nil {
		return "", errors.New("md_tmpl: render returned nil without error")
	}

	output := C.GoString(result)
	C.pt_free_string(result)
	return output, nil
}

// RenderUnchecked renders the template without validating the context against
// the frontmatter declarations.
//
// This skips the type- and presence-checks performed by [Render], trading
// safety for speed. Only use it when the context is known to be valid (for
// example, when it was produced by a previous validated render). Undefined
// variables referenced by the body still error during rendering.
func (t *Template) RenderUnchecked(ctx *Context) (string, error) {
	if t.ptr == nil {
		return "", ErrClosed
	}
	if ctx == nil || ctx.ptr == nil {
		return "", ErrNilContext
	}

	var errPtr *C.char
	result := C.pt_template_render_unchecked(t.ptr, ctx.ptr, &errPtr)
	if errPtr != nil {
		return "", freeError(errPtr)
	}
	if result == nil {
		return "", errors.New("md_tmpl: render returned nil without error")
	}

	output := C.GoString(result)
	C.pt_free_string(result)
	return output, nil
}

// RenderCached renders the template, resolving {% include %} directives through
// the given [Cache].
//
// Nested includes that were previously compiled are reused instead of being
// re-parsed, which speeds up rendering of templates with a shared include set.
// The cache must not be closed for the duration of the call.
func (t *Template) RenderCached(ctx *Context, cache *Cache) (string, error) {
	if t.ptr == nil {
		return "", ErrClosed
	}
	if ctx == nil || ctx.ptr == nil {
		return "", ErrNilContext
	}
	if cache == nil || cache.ptr == nil {
		return "", ErrClosed
	}

	var errPtr *C.char
	result := C.pt_template_render_cached(t.ptr, ctx.ptr, cache.ptr, &errPtr)
	if errPtr != nil {
		return "", freeError(errPtr)
	}
	if result == nil {
		return "", errors.New("md_tmpl: render returned nil without error")
	}

	output := C.GoString(result)
	C.pt_free_string(result)
	return output, nil
}

// RenderMap is a convenience method that creates a Context from a map,
// renders the template, and returns the result.
//
// Map values are automatically converted:
//   - string → str
//   - int/int64 → int
//   - float64 → float
//   - bool → bool
//   - anything else → JSON-encoded and set via SetJSON
func (t *Template) RenderMap(params map[string]any, opts ...RenderOption) (string, error) {
	return t.renderMapWith(params, resolveRenderConfig(opts).allowExtra)
}

// RenderJSON renders the template using a JSON string as the parameter source.
//
// The JSON string must be a JSON object (`{}`). Each top-level key becomes
// a template parameter. This is the most efficient rendering path: a single
// FFI call populates the entire context.
//
// Example:
//
//	result, err := tmpl.RenderJSON(`{"name": "Alice", "count": 42}`)
//
// Pass [AllowExtra] to permit undeclared parameters.
func (t *Template) RenderJSON(jsonStr string, opts ...RenderOption) (string, error) {
	return t.renderJSONWith(jsonStr, resolveRenderConfig(opts).allowExtra)
}

// renderJSONWith is the shared implementation backing RenderJSON.
//
// Uses a single-shot FFI call (pt_template_render_json) that parses JSON,
// builds the context, and renders entirely on the Rust side — avoiding the
// overhead of 3 separate FFI round-trips.
func (t *Template) renderJSONWith(jsonStr string, allowExtra bool) (string, error) {
	if t.ptr == nil {
		return "", ErrClosed
	}

	cJSON := C.CString(jsonStr)
	defer C.free(unsafe.Pointer(cJSON))

	var errPtr *C.char
	result := C.pt_template_render_json(t.ptr, cJSON, C._Bool(allowExtra), &errPtr)
	if errPtr != nil {
		return "", freeError(errPtr)
	}
	if result == nil {
		return "", errors.New("md_tmpl: render returned nil without error")
	}

	output := C.GoString(result)
	C.pt_free_string(result)
	return output, nil
}

// RenderStruct renders the template using a Go struct as the parameter source.
//
// Struct fields are mapped to template parameters by their json tag name,
// falling back to the lowercased field name. Unexported fields are skipped.
//
// Internally this marshals the struct to FlexBuffers and populates the context in
// a single FFI call, which is significantly faster than per-field reflection.
//
// Example:
//
//	type Params struct {
//	    Name  string `json:"name"`
//	    Count int64  `json:"count"`
//	}
//	result, err := tmpl.RenderStruct(Params{Name: "Alice", Count: 42})
//
// Pass [AllowExtra] to permit undeclared parameters.
func (t *Template) RenderStruct(v any, opts ...RenderOption) (string, error) {
	return t.renderFlexbuffersWith(v, resolveRenderConfig(opts).allowExtra)
}

// renderMapWith is the shared implementation backing RenderMap.
//
// Marshals the map to FlexBuffers and uses the single-shot FFI path, replacing
// the per-key Set() calls that each crossed the FFI boundary.
func (t *Template) renderMapWith(params map[string]any, allowExtra bool) (string, error) {
	return t.renderFlexbuffersWith(params, allowExtra)
}

// renderFlexbuffersWith marshals the value to FlexBuffers and uses the single-shot FFI path.
func (t *Template) renderFlexbuffersWith(v any, allowExtra bool) (string, error) {
	if t.ptr == nil {
		return "", ErrClosed
	}

	data, err := marshalFlexbuffers(v)
	if err != nil {
		return "", fmt.Errorf("renderFlexbuffersWith: cannot marshal to flexbuffers: %w", err)
	}
	if len(data) == 0 {
		return "", errors.New("md_tmpl: renderFlexbuffersWith: empty flexbuffers data")
	}

	var errPtr *C.char
	result := C.pt_template_render_flexbuffers(t.ptr, (*C.uint8_t)(&data[0]), C.size_t(len(data)), C._Bool(allowExtra), &errPtr)
	if errPtr != nil {
		return "", freeError(errPtr)
	}
	if result == nil {
		return "", errors.New("md_tmpl: render returned nil without error")
	}

	output := C.GoString(result)
	C.pt_free_string(result)
	return output, nil
}

// ---------------------------------------------------------------------------
// Template metadata
// ---------------------------------------------------------------------------

// SourceHash returns the content hash of the template source.
//
// Two templates compiled from the same source produce the same hash.
func (t *Template) SourceHash() uint64 {
	if t.ptr == nil {
		return 0
	}
	return uint64(C.pt_template_source_hash(t.ptr))
}

// Body returns the template body text after frontmatter stripping.
func (t *Template) Body() string {
	if t.ptr == nil {
		return ""
	}
	cBody := C.pt_template_body(t.ptr)
	body := C.GoString(cBody)
	C.pt_free_string(cBody)
	return body
}

// Name returns the template name declared in frontmatter and whether one was
// present. An absent name yields ("", false), distinct from an empty name.
func (t *Template) Name() (string, bool) {
	if t.ptr == nil {
		return "", false
	}
	c := C.pt_template_name(t.ptr)
	if c == nil {
		return "", false
	}
	name := C.GoString(c)
	C.pt_free_string(c)
	return name, true
}

// Description returns the template description declared in frontmatter and
// whether one was present. An absent description yields ("", false).
func (t *Template) Description() (string, bool) {
	if t.ptr == nil {
		return "", false
	}
	c := C.pt_template_description(t.ptr)
	if c == nil {
		return "", false
	}
	desc := C.GoString(c)
	C.pt_free_string(c)
	return desc, true
}

// Declarations returns the declared parameter names, types, and defaults.
func (t *Template) Declarations() []Declaration {
	if t.ptr == nil {
		return nil
	}
	cDecls := C.pt_template_declarations(t.ptr)
	jsonStr := C.GoString(cDecls)
	C.pt_free_string(cDecls)

	var raw [][]string
	if err := json.Unmarshal([]byte(jsonStr), &raw); err != nil {
		debugLog.Printf("Declarations: failed to parse JSON: %v", err)
		return nil
	}
	if len(raw) == 0 {
		return nil
	}

	// Only cross the FFI boundary for defaults once we know there are
	// declarations to attach them to.
	defaults := t.Defaults()

	decls := make([]Declaration, 0, len(raw))
	for _, pair := range raw {
		if len(pair) == 2 {
			d := Declaration{Name: pair[0], Type: pair[1]}
			if defaults != nil {
				d.Default = defaults[pair[0]] // nil if not present
			}
			decls = append(decls, d)
		}
	}
	return decls
}

// Defaults returns a map of parameter names to their default values.
// Only parameters with defaults are included.
func (t *Template) Defaults() map[string]any {
	if t.ptr == nil {
		return nil
	}
	raw := C.pt_template_defaults_json(t.ptr)
	defer C.pt_free_string(raw)
	jsonStr := C.GoString(raw)

	var result map[string]any
	if err := json.Unmarshal([]byte(jsonStr), &result); err != nil {
		debugLog.Printf("Defaults: failed to parse JSON: %v", err)
		return nil
	}
	return result
}

// Constants returns a map of constant names to their values.
func (t *Template) Constants() map[string]any {
	if t.ptr == nil {
		return nil
	}
	raw := C.pt_template_consts_json(t.ptr)
	defer C.pt_free_string(raw)
	jsonStr := C.GoString(raw)

	var result map[string]any
	if err := json.Unmarshal([]byte(jsonStr), &result); err != nil {
		debugLog.Printf("Constants: failed to parse JSON: %v", err)
		return nil
	}
	return result
}

// ImportedConstants returns constants imported from other templates.
//
// These are keyed by "stem.NAME" (e.g. "other.MAX_RETRIES").
// Returns nil if no imported constants exist.
func (t *Template) ImportedConstants() map[string]any {
	if t.ptr == nil {
		return nil
	}
	raw := C.pt_template_imported_consts_json(t.ptr)
	defer C.pt_free_string(raw)
	jsonStr := C.GoString(raw)

	var result map[string]any
	if err := json.Unmarshal([]byte(jsonStr), &result); err != nil {
		debugLog.Printf("ImportedConstants: failed to parse JSON: %v", err)
		return nil
	}
	if len(result) == 0 {
		return nil
	}
	return result
}

// DefaultsContext returns a new Context pre-filled with all default values.
// Use this as a starting point, then override only the params you need.
//
// Returns nil if the template is closed.
// The caller must call Close on the returned context.
func (t *Template) DefaultsContext() *Context {
	if t.ptr == nil {
		return nil
	}
	ctx := &Context{ptr: C.pt_template_defaults_context(t.ptr)}
	runtime.SetFinalizer(ctx, func(c *Context) { c.Close() })
	return ctx
}

// SetMaxIncludeDepth sets the maximum nesting depth for {% include %} directives.
func (t *Template) SetMaxIncludeDepth(depth int) {
	if t.ptr != nil {
		C.pt_template_set_max_include_depth(t.ptr, C.size_t(depth))
	}
}

// ValidateDeclarations checks that the template's parameter declarations
// match the expected set.
//
// Pass the expected declarations (e.g. from a previous snapshot). If the
// declarations have changed (added, removed, or retyped parameters), an
// error is returned describing the differences.
//
// This is useful for detecting template changes at load time.
func (t *Template) ValidateDeclarations(expected []Declaration) error {
	if t.ptr == nil {
		return ErrClosed
	}

	// Encode expected as JSON array of [name, type] pairs.
	pairs := make([][]string, len(expected))
	for i, d := range expected {
		pairs[i] = []string{d.Name, d.Type}
	}
	data, err := json.Marshal(pairs)
	if err != nil {
		return fmt.Errorf("cannot marshal declarations: %w", err)
	}

	cJSON := C.CString(string(data))
	defer C.free(unsafe.Pointer(cJSON))

	errPtr := C.pt_template_validate_declarations(t.ptr, cJSON)
	return freeError(errPtr)
}
