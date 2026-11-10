case $action in
  attach) roots=$*; backend_attach $(descendants "$@") || exit 1 ;;
  join) backend_exists || exit 0; roots=$*; backend_attach $(descendants "$@") || exit 1 ;;
  kill) reap ;;
esac
