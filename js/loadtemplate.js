$(function () {
    var includes = $('[data-include]')
    $.each(includes, function () {
      var file = '/templates/' + $(this).data('include') + '.html'
      $(this).load(file)
    })
  })

  function redirNew(link){
    window.open(link, '_blank').focus();
  }