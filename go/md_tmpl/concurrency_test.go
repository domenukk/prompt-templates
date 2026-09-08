package md_tmpl_test

import (
	"fmt"
	"sync"
	"testing"

	"github.com/domenukk/md-tmpl/go/md_tmpl"
)

func TestConcurrentSharedTemplateRender(t *testing.T) {
	tmpl, err := md_tmpl.FromSource(`---
params:
  - id = int
  - label = str
---
Item #{{ id }}: {{ label }}`)
	if err != nil {
		t.Fatalf("FromSource: %v", err)
	}
	defer tmpl.Close()

	const numGoroutines = 64
	var wg sync.WaitGroup
	errs := make(chan error, numGoroutines)

	for i := 0; i < numGoroutines; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			ctx := md_tmpl.NewContext()
			defer ctx.Close()
			if err := ctx.SetInt("id", int64(idx)); err != nil {
				errs <- fmt.Errorf("goroutine %d SetInt: %w", idx, err)
				return
			}
			label := fmt.Sprintf("worker-%d", idx)
			if err := ctx.SetStr("label", label); err != nil {
				errs <- fmt.Errorf("goroutine %d SetStr: %w", idx, err)
				return
			}
			out, err := tmpl.Render(ctx)
			if err != nil {
				errs <- fmt.Errorf("goroutine %d Render: %w", idx, err)
				return
			}
			want := fmt.Sprintf("Item #%d: worker-%d", idx, idx)
			if out != want {
				errs <- fmt.Errorf("goroutine %d got %q, want %q", idx, out, want)
			}
		}(i)
	}

	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
}
