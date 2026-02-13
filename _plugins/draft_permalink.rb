module Jekyll
  Hooks.register :posts, :post_init do |post|
    tags = post.data['tags'] || []
    next unless tags.include?('draft')
    next if post.data['permalink']

    post.data['permalink'] = "/drafts/#{post.date.strftime('%Y/%m-%d')}/#{post.slug}/"
  end
end
